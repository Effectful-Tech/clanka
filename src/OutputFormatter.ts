/**
 * @since 1.0.0
 */
import { Sink } from "effect"
import type { Output } from "./Agent.ts"

/**
 * @since 1.0.0
 * @category Models
 */
export type OutputFormatter<E = never, R = never> = Sink.Sink<
  void,
  Output,
  never,
  E,
  R
>
