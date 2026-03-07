import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as TypeBuilder from "./TypeBuilder.ts"

const lines = (...parts: ReadonlyArray<string>): string => parts.join("\n")

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

  it("renders structs", () => {
    expect(
      TypeBuilder.render(
        Schema.Struct({
          name: Schema.String,
          age: Schema.Number,
        }),
      ),
    ).toBe(
      lines(
        "{",
        "    readonly name: string;",
        "    readonly age: number;",
        "}",
      ),
    )
  })

  it("renders optional properties", () => {
    expect(
      TypeBuilder.render(
        Schema.Struct({
          nickname: Schema.optionalKey(Schema.String),
        }),
      ),
    ).toBe(lines("{", "    readonly nickname?: string;", "}"))
  })

  it("renders mutable properties", () => {
    expect(
      TypeBuilder.render(
        Schema.Struct({
          count: Schema.mutableKey(Schema.Number),
        }),
      ),
    ).toBe(lines("{", "    count: number;", "}"))
  })

  it("renders symbol property keys", () => {
    const token = Symbol("token")

    expect(
      TypeBuilder.render(
        Schema.Struct({
          [token]: Schema.String,
        }),
      ),
    ).toBe(lines("{", '    readonly [Symbol.for("token")]: string;', "}"))
  })

  it("renders records", () => {
    expect(
      TypeBuilder.render(Schema.Record(Schema.String, Schema.Number)),
    ).toBe(lines("{", "    [x: string]: number;", "}"))
  })

  it("renders structs with rest records", () => {
    expect(
      TypeBuilder.render(
        Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
          Schema.Record(Schema.String, Schema.Boolean),
        ]),
      ),
    ).toBe(
      lines(
        "{",
        "    readonly name: string;",
        "    [x: string]: boolean;",
        "}",
      ),
    )
  })

  it("renders readonly arrays", () => {
    expect(TypeBuilder.render(Schema.Array(Schema.String))).toBe(
      "readonly string[]",
    )
  })

  it("renders mutable arrays", () => {
    expect(
      TypeBuilder.render(Schema.mutable(Schema.Array(Schema.String))),
    ).toBe("string[]")
  })

  it("renders readonly tuples", () => {
    expect(
      TypeBuilder.render(Schema.Tuple([Schema.String, Schema.Number])),
    ).toBe(lines("readonly [", "    string,", "    number", "]"))
  })

  it("renders mutable tuples", () => {
    expect(
      TypeBuilder.render(
        Schema.mutable(Schema.Tuple([Schema.String, Schema.Number])),
      ),
    ).toBe(lines("[", "    string,", "    number", "]"))
  })

  it("renders optional tuple elements", () => {
    expect(
      TypeBuilder.render(
        Schema.Tuple([Schema.String, Schema.optional(Schema.Number)]),
      ),
    ).toBe(lines("readonly [", "    string,", "    number?", "]"))
  })

  it("renders tuples with rest elements", () => {
    expect(
      TypeBuilder.render(
        Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
          Schema.Number,
          Schema.Boolean,
        ]),
      ),
    ).toBe(
      lines(
        "readonly [",
        "    string,",
        "    ...number[],",
        "    boolean",
        "]",
      ),
    )
  })

  it("renders unions", () => {
    expect(
      TypeBuilder.render(Schema.Union([Schema.String, Schema.Number])),
    ).toBe("string | number")
  })

  it("renders empty unions as never", () => {
    expect(TypeBuilder.render(Schema.Union([]))).toBe("never")
  })

  it("renders single-member unions without separators", () => {
    expect(TypeBuilder.render(Schema.Union([Schema.String]))).toBe("string")
  })

  it("renders literal unions", () => {
    expect(TypeBuilder.render(Schema.Literals(["a", "b"]))).toBe('"a" | "b"')
  })

  it("renders enums as unions of member values", () => {
    expect(
      TypeBuilder.render(
        Schema.Enum({
          Apple: "apple",
          Banana: "banana",
        }),
      ),
    ).toBe('"apple" | "banana"')
  })

  it("renders numeric enums as literal unions", () => {
    expect(
      TypeBuilder.render(
        Schema.Enum({
          Ok: 200,
          NotFound: 404,
        }),
      ),
    ).toBe("200 | 404")
  })

  it("renders numeric enum reverse mappings as literal unions", () => {
    expect(
      TypeBuilder.render(
        Schema.Enum({
          200: "Ok",
          404: "NotFound",
          Ok: 200,
          NotFound: 404,
        }),
      ),
    ).toBe("200 | 404")
  })

  it("renders template literals with interpolations", () => {
    expect(
      TypeBuilder.render(Schema.TemplateLiteral(["user_", Schema.String])),
    ).toBe("`user_${string}`")
  })

  it("renders template literals that start with interpolations", () => {
    expect(
      TypeBuilder.render(Schema.TemplateLiteral([Schema.String, "_suffix"])),
    ).toBe("`${string}_suffix`")
  })

  it("renders all-literal template literals as string literals", () => {
    expect(
      TypeBuilder.render(Schema.TemplateLiteral(["user_", 42n, "_", 7])),
    ).toBe('"user_42_7"')
  })

  it("flattens nested template literals", () => {
    expect(
      TypeBuilder.render(
        Schema.TemplateLiteral([
          "a",
          Schema.TemplateLiteral(["b", Schema.Number]),
          "c",
        ]),
      ),
    ).toBe("`ab${number}c`")
  })

  it("renders unions inside template literal interpolations", () => {
    expect(
      TypeBuilder.render(
        Schema.TemplateLiteral([
          Schema.String,
          Schema.Union([Schema.Literal("-"), Schema.Literal("_")]),
          Schema.Number,
        ]),
      ),
    ).toBe('`${string}${"-" | "_"}${number}`')
  })

  it("renders optional tuple elements with union members", () => {
    expect(
      TypeBuilder.render(
        Schema.Tuple([
          Schema.String,
          Schema.optional(Schema.Union([Schema.Number, Schema.Boolean])),
        ]),
      ),
    ).toBe(lines("readonly [", "    string,", "    (number | boolean)?", "]"))
  })

  it("renders tuples with composite rest element types", () => {
    expect(
      TypeBuilder.render(
        Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
          Schema.Union([Schema.Number, Schema.Boolean]),
          Schema.Boolean,
        ]),
      ),
    ).toBe(
      lines(
        "readonly [",
        "    string,",
        "    ...(number | boolean)[],",
        "    boolean",
        "]",
      ),
    )
  })

  it("renders documented fields", () => {
    expect(
      TypeBuilder.render(
        Schema.Struct({
          token: Schema.String.annotate({ documentation: "Primary token" }),
        }),
      ),
    ).toBe(
      lines(
        "{",
        "    /** Primary token */",
        "    readonly token: string;",
        "}",
      ),
    )
  })
})
