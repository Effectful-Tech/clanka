import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as TypeBuilder from "./TypeBuilder.ts"

const primitiveCases = [
  ["string", Schema.String, "string"],
  ["number", Schema.Number, "number"],
  ["boolean", Schema.Boolean, "boolean"],
  ["bigint", Schema.BigInt, "bigint"],
  ["symbol", Schema.Symbol, "symbol"],
  ["any", Schema.Any, "any"],
  ["unknown", Schema.Unknown, "unknown"],
  ["void", Schema.Void, "void"],
  ["never", Schema.Never, "never"],
  ["undefined", Schema.Undefined, "undefined"],
  ["null", Schema.Null, "null"],
  ["object", Schema.ObjectKeyword, "object"],
] as const satisfies ReadonlyArray<
  readonly [name: string, schema: Schema.Top, expected: string]
>

const literalCases = [
  ["string literals", Schema.Literal("hello"), '"hello"'],
  ["number literals", Schema.Literal(42), "42"],
  ["boolean literals", Schema.Literal(true), "true"],
  ["bigint literals", Schema.Literal(42n), "42n"],
  ["negative zero literals", Schema.Literal(-0), "-0"],
  ["negative number literals", Schema.Literal(-42), "-42"],
  ["negative bigint literals", Schema.Literal(-42n), "-42n"],
] as const satisfies ReadonlyArray<
  readonly [name: string, schema: Schema.Top, expected: string]
>

describe("TypeBuilder", () => {
  for (const [name, schema, expected] of primitiveCases) {
    it(`renders ${name}`, () => {
      expect(TypeBuilder.render(schema)).toBe(expected)
    })
  }

  for (const [name, schema, expected] of literalCases) {
    it(`renders ${name}`, () => {
      expect(TypeBuilder.render(schema)).toBe(expected)
    })
  }

  it("renders described unique symbols", () => {
    expect(TypeBuilder.render(Schema.UniqueSymbol(Symbol("token")))).toBe(
      'typeof Symbol.for("token")',
    )
  })

  it("renders anonymous unique symbols", () => {
    expect(TypeBuilder.render(Schema.UniqueSymbol(Symbol()))).toBe(
      "unique symbol",
    )
  })
})
