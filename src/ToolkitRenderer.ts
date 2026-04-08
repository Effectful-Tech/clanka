/**
 * @since 1.0.0
 */
import * as Array from "effect/Array"
import * as Layer from "effect/Layer"
import * as SchemaAST from "effect/SchemaAST"
import * as Context from "effect/Context"
import type * as Tool from "effect/unstable/ai/Tool"
import type * as Toolkit from "effect/unstable/ai/Toolkit"
import * as TypeBuilder from "./TypeBuilder.ts"
import * as Function from "effect/Function"

/**
 * @since 1.0.0
 * @category Services
 */
export class ToolkitRenderer extends Context.Service<
  ToolkitRenderer,
  {
    render<Tools extends Record<string, Tool.Any>>(
      tools: Toolkit.Toolkit<Tools>,
    ): string
  }
>()("clanka/ToolkitRenderer") {
  static readonly layer = Layer.succeed(ToolkitRenderer, {
    render: Function.memoize(
      <Tools extends Record<string, Tool.Any>>(
        tools: Toolkit.Toolkit<Tools>,
      ) => {
        const output = Array.empty<string>()
        for (const [name, tool] of Object.entries(tools.tools)) {
          const paramName =
            SchemaAST.resolveIdentifier(tool.parametersSchema.ast) ?? "options"
          const paramType = TypeBuilder.render(tool.parametersSchema)
          const params =
            paramType === "void" ? "" : `${paramName}: ${paramType}`
          output.push(
            `/** ${tool.description} */
declare function ${name}(${params}): Promise<${TypeBuilder.render(tool.successSchema)}>`,
          )
        }
        return output.join("\n\n")
      },
    ),
  })
}
