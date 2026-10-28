import { commandPolicies, type CommandName } from "../../shared/command-policies.js";

export function notesCommandAllowed(command: string): boolean {
  return Object.hasOwn(commandPolicies, command) && commandPolicies[command as CommandName].notes;
}
