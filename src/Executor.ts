import {
  Cause,
  Console,
  Effect,
  FiberSet,
  Layer,
  Queue,
  ServiceMap,
  Stream,
} from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as NodeConsole from "node:console"
import * as NodeVm from "node:vm"
import { Writable } from "node:stream"

export class Executor extends ServiceMap.Service<
  Executor,
  {
    execute<Tools extends Record<string, Tool.Any>>(options: {
      readonly tools: Toolkit.WithHandler<Tools>
      readonly script: string
    }): Stream.Stream<string, never, Tool.HandlerServices<Tools[keyof Tools]>>
  }
>()("clanka/Executor") {
  static readonly layer = Layer.effect(
    Executor,
    // oxlint-disable-next-line require-yield
    Effect.gen(function* () {
      const execute = Effect.fnUntraced(function* <
        Tools extends Record<string, Tool.Any>,
      >(options: {
        readonly tools: Toolkit.WithHandler<Tools>
        readonly script: string
      }) {
        const output = yield* Queue.unbounded<string, Cause.Done>()

        yield* Effect.gen(function* () {
          const console = yield* Console.Console
          const services = yield* Effect.services()
          const runPromise = yield* FiberSet.makeRuntimePromise()

          const script = new NodeVm.Script(`async function main() {
${options.script}
}`)
          const sandbox: ScriptSandbox = {
            main: defaultMain,
            console,
          }

          for (const [name, tool] of Object.entries(options.tools.tools)) {
            const handler = services.mapUnsafe.get(
              tool.id,
            ) as Tool.Handler<string>
            // oxlint-disable-next-line typescript/no-explicit-any
            sandbox[name] = function (params: any) {
              return handler
                .handler(params, {})
                .pipe(Effect.provideServices(handler.services), runPromise)
            }
          }

          script.runInNewContext(sandbox, {
            timeout: 1000,
          })
          yield* Effect.promise(sandbox.main)
        }).pipe(
          Effect.timeout("3 minutes"),
          Effect.catchCause(Effect.logFatal),
          Effect.provideServiceEffect(Console.Console, makeConsole(output)),
          Effect.scoped,
          Effect.ensuring(Queue.end(output)),
          Effect.forkScoped,
        )

        return Stream.fromQueue(output)
      }, Stream.unwrap)

      return Executor.of({
        execute,
      })
    }),
  )
}

interface ScriptSandbox {
  main: () => Promise<void>
  console: Console.Console
  [toolName: string]: unknown
}

const defaultMain = () => Promise.resolve()

const makeConsole = Effect.fn(function* (
  queue: Queue.Queue<string, Cause.Done>,
) {
  const writable = new QueueWriteStream(queue)
  const newConsole = new NodeConsole.Console(writable)
  yield* Effect.addFinalizer(() => {
    writable.end()
    return Effect.void
  })
  return newConsole
})

class QueueWriteStream extends Writable {
  readonly queue: Queue.Enqueue<string, Cause.Done>
  constructor(queue: Queue.Enqueue<string, Cause.Done>) {
    super()
    this.queue = queue
  }
  _write(
    // oxlint-disable-next-line typescript/no-explicit-any
    chunk: any,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    Queue.offerUnsafe(this.queue, chunk.toString())
    callback()
  }
}
