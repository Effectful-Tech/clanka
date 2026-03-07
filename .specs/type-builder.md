# TypeBuilder Specification

Port of `.repos/content/packages/core/src/TypeBuilder.ts` to `src/TypeBuilder.ts`
for Effect v4 (4.0.0-beta.28).

## Overview

`TypeBuilder` converts an Effect `Schema` definition into a TypeScript type
expression string. It walks the `SchemaAST` tree and builds TypeScript AST nodes
using the TypeScript compiler API, then prints them to a string.

```ts
import { Schema } from "effect"
import * as TypeBuilder from "./TypeBuilder.ts"

const User = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
})

TypeBuilder.render(User) // => "{ readonly name: string; readonly age: number }"
```

## Public API

### `render`

```ts
export const render: (schema: Schema.Top, options?: ts.PrinterOptions) => string
```

Takes any Effect Schema and returns its TypeScript type expression as a string.
Operates on the **Type** (decoded) side of the schema. `Schema.Top` is the v4
replacement for the old `Schema.Schema.Any` type.

The optional `options` parameter is passed through to the TypeScript printer for
controlling formatting (e.g., `newLine`, `omitTrailingSemicolon`).

## Core Strategy: `AST.toType`

Before traversing, the `render` function calls `AST.toType(schema.ast)` once to
obtain the **decoded-side AST**. This function:

- Strips all `encoding` chains (transformations to/from wire format).
- Strips all `checks` (runtime refinements/filters).
- Recursively processes composite nodes (`Objects`, `Arrays`, `Union`,
  `Suspend`).
- Preserves `context` on AST nodes (optionality, mutability metadata).
- Is memoized internally by Effect.

After `toType`, the traversal only needs to handle the core node types without
worrying about encoding or checks.

## AST Node Mapping

The traversal function maps each AST node `_tag` to a TypeScript type node.
Below is the complete mapping for every AST node type in Effect v4.

### v3 to v4 Tag Reference

For porters coming from the original implementation, here is the mapping of old
to new AST tags:

| Old v3 `_tag`        | New v4 `_tag` | Notes                          |
| -------------------- | ------------- | ------------------------------ |
| `"StringKeyword"`    | `"String"`    | Renamed                        |
| `"NumberKeyword"`    | `"Number"`    | Renamed                        |
| `"BooleanKeyword"`   | `"Boolean"`   | Renamed                        |
| `"BigIntKeyword"`    | `"BigInt"`    | Renamed                        |
| `"SymbolKeyword"`    | `"Symbol"`    | Renamed                        |
| `"UndefinedKeyword"` | `"Undefined"` | Renamed                        |
| `"VoidKeyword"`      | `"Void"`      | Renamed                        |
| `"NeverKeyword"`     | `"Never"`     | Renamed                        |
| `"UnknownKeyword"`   | `"Unknown"`   | Renamed                        |
| `"AnyKeyword"`       | `"Any"`       | Renamed                        |
| `"TypeLiteral"`      | `"Objects"`   | Renamed                        |
| `"TupleType"`        | `"Arrays"`    | Renamed                        |
| `"Enums"`            | `"Enum"`      | Singular                       |
| `"Literal"`          | `"Literal"`   | `null` is now its own `"Null"` |
| `"Refinement"`       | _(removed)_   | Now `checks` on `Base`         |
| `"Transformation"`   | _(removed)_   | Now `encoding` on `Base`       |

### Primitive Keywords

| AST `_tag`        | TypeScript Output |
| ----------------- | ----------------- |
| `"String"`        | `string`          |
| `"Number"`        | `number`          |
| `"Boolean"`       | `boolean`         |
| `"BigInt"`        | `bigint`          |
| `"Symbol"`        | `symbol`          |
| `"Any"`           | `any`             |
| `"Unknown"`       | `unknown`         |
| `"Void"`          | `void`            |
| `"Never"`         | `never`           |
| `"Undefined"`     | `undefined`       |
| `"Null"`          | `null`            |
| `"ObjectKeyword"` | `object`          |

### `Literal`

Renders the exact literal type. In v4, `LiteralValue` is
`string | number | boolean | bigint`. Note that `null` is **not** a literal in
v4 -- it has its own `Null` AST node (handled above in primitives).

- `string` literal -> `"hello"`
- `number` literal -> `42`
- `boolean` literal -> `true` / `false`
- `bigint` literal -> `42n`

### `UniqueSymbol`

Renders as `typeof Symbol.for("description")` if the symbol has a description,
otherwise renders as `unique symbol`.

> This is an approximation -- `typeof Symbol.for("x")` is not truly a
> `unique symbol` in TypeScript. However, it conveys intent and is the closest
> representation without a named variable.

### `Enum`

Renders as a **union of the enum's literal values**. This is a deliberate
simplification from the original implementation, which emitted TypeScript `enum`
declarations. Since we only output type expressions (no declarations), a union
of literals is more appropriate.

```ts
// Given: enum Fruit { Apple = "apple", Banana = "banana" }
Schema.Enums(Fruit) // -> renders as: "apple" | "banana"
```

Each member's value (`ast.enums`) is rendered as a string or numeric literal
type, joined with `|`.

### `TemplateLiteral`

The v4 `TemplateLiteral` has a flat `parts: ReadonlyArray<AST>` array (unlike v3
which had `head: string` and `spans: Array<{type, literal}>`).

Valid part types (`TemplateLiteralPart`):
`String | Number | BigInt | Literal | TemplateLiteral | Union<TemplateLiteralPart>`

**Rendering algorithm:**

1. Walk through `parts` left-to-right, building a TypeScript template literal
   type using `ts.factory.createTemplateLiteralType(head, spans)`.
2. Group consecutive `Literal` parts into the literal text portions of the
   template (head and span literals).
3. Non-literal parts become `${type}` interpolation spans:
   - `String` -> `${string}`
   - `Number` -> `${number}`
   - `BigInt` -> `${bigint}`
   - `Union` parts -> `${A | B}` (render the union inline)
   - Nested `TemplateLiteral` parts -> flatten/inline into the outer template
4. The first literal text becomes the `TemplateHead`. Subsequent literal texts
   become `TemplateMiddle` (or `TemplateTail` for the last).
5. If the template has no interpolation spans (all parts are literals), render
   as a string literal type instead.

### `Objects`

Renders as a TypeScript object type literal with property signatures and index
signatures.

#### Property Signatures

For each `PropertySignature` in `ast.propertySignatures`:

- **Name**: The property key. String/number keys become identifiers. Symbol keys
  become computed property names using `[Symbol.for("description")]`.
- **Optionality**: Use `AST.isOptional(ps.type)` (checks
  `ps.type.context?.isOptional`). If `true`, the property gets a `?` token.
- **Readonly**: Use `AST.isMutable(ps.type)` (checks
  `ps.type.context?.isMutable`). If `false` or `undefined`, the property gets
  the `readonly` modifier. If `true`, no modifier.
- **Type**: The property's value type, recursively rendered from `ps.type`. The
  `context` on the type AST is metadata about the property key and does not
  affect the rendered type itself.
- **JSDoc**: If the property's type AST has a `"documentation"` annotation
  (resolved via `AST.resolveAt("documentation")(ps.type)`), a JSDoc comment is
  added above the property.

> **v4 difference**: In v3, `PropertySignature` had `isOptional` and
> `isReadonly` fields directly. In v4, these live on `ps.type.context`.
> The helper functions `AST.isOptional()` and `AST.isMutable()` should be used
> for access.

#### Index Signatures

For each `IndexSignature` in `ast.indexSignatures`:

- **Parameter**: The key type, recursively rendered (typically `string`,
  `number`, or `symbol`).
- **Type**: The value type, recursively rendered.
- **Readonly**: In v4, `IndexSignature` has no per-signature readonly flag
  (only `parameter`, `type`, and `merge`). Index signatures are rendered
  without `readonly` modifier.

### `Arrays`

Handles both tuples and arrays. The `Arrays` node has:

- `isMutable: boolean` -- top-level field on the node itself
- `elements: ReadonlyArray<AST>` -- tuple element types
- `rest: ReadonlyArray<AST>` -- rest/spread element types

#### Array (simple case)

When `elements` is empty and `rest` has exactly one element, renders as an array
type:

- If `isMutable` is `false`: `readonly T[]`
- If `isMutable` is `true`: `T[]`

#### Tuple

When `elements` is non-empty or `rest` has multiple entries, renders as a tuple:

- Each element from `elements` is rendered. If `AST.isOptional(element)` is
  `true`, the element gets a `?` suffix (optional tuple element).
- If `rest` is non-empty, the first rest element becomes `...T[]` and subsequent
  rest elements become trailing types.
- If `isMutable` is `false`: `readonly [...]`
- If `isMutable` is `true`: `[...]`

### `Union`

Renders as a TypeScript union type: `A | B | C`.

All members of `ast.types` are recursively rendered and joined with `|`.

**Edge cases:**

- Zero members: render as `never`.
- One member: render as just that member's type (no `|`).

### `Declaration`

Handled by checking for an identifier annotation:

1. If `AST.resolveIdentifier(ast)` returns a string, render as a type reference
   using that identifier with any `typeParameters` rendered as generic arguments.
2. If no identifier is found, render as `unknown`.

> **Note**: `resolveIdentifier` checks `ast.checks[last].annotations` first,
> then falls back to `ast.annotations`. This covers class schemas which use
> `ClassTypeId` annotation and have identifiers.

### `Suspend`

Evaluates the lazy thunk (`ast.thunk()`) and recursively renders the result.
In v4, `Suspend.thunk` is memoized, so repeated calls return the same AST
reference.

**Cycle detection**: Maintain a `Set<AST>` of visited `Suspend` nodes. Before
resolving a `Suspend`, add it to the set. If the resolved AST leads to a
`Suspend` already in the set, render the identifier annotation from the resolved
AST (via `AST.resolveIdentifier`) if available, otherwise render as `unknown`.

> After `toType`, `Suspend` nodes are preserved (as new `Suspend` instances
> wrapping the recursed thunk), so cycle detection remains necessary.

## Special Cases

### Branded Types

Brands (added via `Schema.brand`) appear as a `"brands"` annotation on the AST.
They do **not** affect the rendered TypeScript type. The underlying type is
rendered as-is (e.g., `Schema.String.pipe(Schema.brand("UserId"))` renders as
`string`).

### Class Schemas

Class schemas produce `Declaration` AST nodes with an identifier annotation
matching the class name. The `Declaration` handling above covers this case --
they render as the class name type reference.

## Annotations

In v4, annotations are **string-keyed** (not symbol-based like v3). Access
patterns:

- `AST.resolve(ast)` -- returns all annotations (`Record<string, unknown>` or
  `undefined`).
- `AST.resolveAt<T>(key)(ast)` -- returns a single annotation value or
  `undefined`.
- `AST.resolveIdentifier(ast)` -- shortcut for `resolveAt<string>("identifier")`.
- `AST.resolveDescription(ast)` -- shortcut for
  `resolveAt<string>("description")`.

For documentation, use `AST.resolveAt("documentation")(ast)`.

## JSDoc Comments

When an AST node or property signature has a `"documentation"` annotation, a
JSDoc comment is added above the corresponding TypeScript node:

```ts
/** Some documentation */
readonly name: string;
```

This uses `ts.addSyntheticLeadingComment` with `MultiLineCommentTrivia`.

## Utility: `printNode`

A helper function to print a TypeScript AST node to a string:

```ts
const printNode = (node: ts.Node, options?: ts.PrinterOptions): string => {
  const sourceFile = ts.createSourceFile(
    "print.ts",
    "",
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  )
  const printer = ts.createPrinter(options)
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
}
```

## Error Handling

- If an AST node type is unrecognized or cannot be rendered, the function
  returns `unknown` for that node rather than throwing. This fallback must be
  present from the initial implementation.
- Cycle detection for `Suspend` prevents infinite loops.

## Implementation Notes

- **Import style**: Use `import * as ts from "typescript"` (namespace import),
  not `import ts from "typescript"`. The project uses
  `verbatimModuleSyntax: true` and `module: "nodenext"`, which requires
  namespace imports for CJS packages.
- **No `any`**: The project's oxlint config sets
  `typescript/no-explicit-any: error`. Use `unknown` or specific types in all
  authored code. The `Schema.Top` type reference is acceptable since it comes
  from Effect's type system.
- **Effect best practices**: Refer to `.repos/effect/LLMS.md` for Effect
  library patterns and best practices.

## Dependencies

- `effect` (4.0.0-beta.28) - `Schema`, `SchemaAST` modules
- `typescript` (5.9.3) - compiler API for building and printing type nodes.
  Must be added to `dependencies` in `package.json` (not just
  `devDependencies`) since it is used at runtime.

## File Location

- Source: `src/TypeBuilder.ts`
- Tests: `src/TypeBuilder.test.ts` (colocated with implementation)

---

## Implementation Plan

### Task 1: Project setup and primitive type rendering

**Files**: `package.json`, `vitest.config.ts`, `src/TypeBuilder.ts`,
`src/TypeBuilder.test.ts`

> Tasks 1 and 2 from the original plan are merged. Without a `.ts` file in
> `src/`, `pnpm check` fails with `TS18003: No inputs were found` because
> `tsconfig.json` has `"include": ["src"]`.

Setup:

- Add `typescript` to `dependencies` in `package.json`.
- Add `vitest` and `@effect/vitest` as dev dependencies.
- Add a `"test"` script: `"test": "vitest run"`.
- Create `vitest.config.ts` with basic configuration.

Implementation:

- Create `src/TypeBuilder.ts` with the `render` function.
- Use `AST.toType(schema.ast)` at the entry point to get the decoded-side AST.
- Implement a `go(ast)` traversal function with a `switch` on `ast._tag`.
- Add a `default` fallback that returns the `unknown` keyword type node.
- Support all primitive keyword nodes: `String` -> `string`, `Number` ->
  `number`, `Boolean` -> `boolean`, `BigInt` -> `bigint`, `Symbol` -> `symbol`,
  `Any` -> `any`, `Unknown` -> `unknown`, `Void` -> `void`, `Never` -> `never`,
  `Undefined` -> `undefined`, `Null` -> `null`, `ObjectKeyword` -> `object`.
- Support `Literal` nodes (string, number, boolean, bigint).
- Support `UniqueSymbol` nodes.
- Include the `printNode` utility function.

Tests (in `src/TypeBuilder.test.ts`):

- `Schema.String` -> `"string"`
- `Schema.Number` -> `"number"`
- `Schema.Boolean` -> `"boolean"`
- `Schema.BigIntFromSelf` -> `"bigint"`
- `Schema.SymbolFromSelf` -> `"symbol"`
- `Schema.Any` -> `"any"`
- `Schema.Unknown` -> `"unknown"`
- `Schema.Void` -> `"void"`
- `Schema.Never` -> `"never"`
- `Schema.Undefined` -> `"undefined"`
- `Schema.Null` -> `"null"`
- `Schema.Object` -> `"object"`
- `Schema.Literal("hello")` -> `"\"hello\""`
- `Schema.Literal(42)` -> `"42"`
- `Schema.Literal(true)` -> `"true"`

Verify: `pnpm install && pnpm check && pnpm test` all pass.

### Task 2: Implement `Objects` rendering (struct/record types)

**Files**: `src/TypeBuilder.ts`, `src/TypeBuilder.test.ts`

Add the `"Objects"` case to the `go` function:

- Property signatures with name, type, optionality (`AST.isOptional`), readonly
  (`AST.isMutable`).
- Symbol property keys as computed property names.
- Index signatures (Record types).
- JSDoc comments from `"documentation"` annotations.

Tests:

- `Schema.Struct({ name: Schema.String, age: Schema.Number })` ->
  `"{ readonly name: string; readonly age: number }"`
- Struct with optional properties (`Schema.optional`).
- Struct with mutable properties.
- `Schema.Record({ key: Schema.String, value: Schema.Number })` ->
  `"{ [x: string]: number }"`
- Struct with `"documentation"` annotation.

Verify: `pnpm check && pnpm test` pass.

### Task 3: Implement `Arrays` rendering (tuples and arrays)

**Files**: `src/TypeBuilder.ts`, `src/TypeBuilder.test.ts`

Add the `"Arrays"` case to the `go` function:

- Simple arrays (readonly and mutable).
- Tuples with elements.
- Optional tuple elements.
- Rest elements in tuples.

Tests:

- `Schema.Array(Schema.String)` -> `"readonly string[]"`
- `Schema.mutable(Schema.Array(Schema.String))` -> `"string[]"`
- `Schema.Tuple(Schema.String, Schema.Number)` ->
  `"readonly [string, number]"`
- Tuple with optional elements.
- Tuple with rest elements.

Verify: `pnpm check && pnpm test` pass.

### Task 4: Implement `Union`, `Enum`, and `TemplateLiteral` rendering

**Files**: `src/TypeBuilder.ts`, `src/TypeBuilder.test.ts`

Add support for:

- `"Union"` -- renders as `A | B | C`, with edge cases for 0 and 1 members.
- `"Enum"` -- renders as a union of literal values.
- `"TemplateLiteral"` -- renders using the algorithm described in the spec
  (grouping consecutive literals, interpolating non-literal parts).

Tests:

- `Schema.Union(Schema.String, Schema.Number)` -> `"string | number"`
- `Schema.Literal("a", "b")` -> `"\"a\" | \"b\"`
- `Schema.Enums(SomeEnum)` -> union of member values.
- `Schema.TemplateLiteral(Schema.Literal("user_"), Schema.String)` ->
  ``"`user_${string}`"``

Verify: `pnpm check && pnpm test` pass.

### Task 5: Implement `Declaration`, `Suspend`, and integration tests

**Files**: `src/TypeBuilder.ts`, `src/TypeBuilder.test.ts`

Add support for:

- `"Declaration"` -- use `AST.resolveIdentifier` or fall back to `unknown`.
- `"Suspend"` -- resolve thunk with cycle detection via `Set<AST>`.

The `go` function must accept a `visited: Set<AST>` parameter (or use a closure)
for cycle detection.

Tests:

- Declaration with identifier (e.g., `Schema.DateFromSelf` -> `"Date"` or
  the identifier from the annotation).
- Recursive schema using `Schema.suspend` (verify no infinite loop, renders
  with identifier or `unknown` at cycle point).
- `Schema.NumberFromString` -> `"number"` (Type side, encoding stripped by
  `toType`).
- Branded schema -> renders underlying type (brands ignored).

Verify: `pnpm check && pnpm test` pass.
