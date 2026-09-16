import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type Registration = { seq: number }

export type State = {
  event: string
  capacity: number
  registrations: Registration[]
}

export function readState(file: string): State {
  const raw = readFileSync(file, "utf8")
  const state = JSON.parse(raw) as State
  return state
}

export function writeState(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8")
}

export function appendRegistration(file: string): State {
  const state = readState(file)
  state.registrations.push({ seq: state.registrations.length + 1 })
  writeState(file, state)
  return state
}
