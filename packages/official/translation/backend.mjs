import { openDictionary } from "./dictionary.mjs";
import { createTranslator } from "./provider.mjs";

export default function translationPlugin(lifetime) {
  const dictionary = openDictionary();
  const translator = createTranslator(lifetime);
  return {
    async activate(activation, context) {
      context.signal.throwIfAborted();
      const input = activation.parameters ?? {};
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Translation parameters must be an object");
      const action =
        input.action ?? (activation.commandId === "translate" ? "translate" : "search");
      switch (action) {
        case "search":
          return dictionary.search(
            input.query ?? (activation.context?.kind === "text" ? activation.context.text : ""),
            input.limit ?? 10,
          );
        case "detail":
          return dictionary.detail(input.id);
        case "configure":
          return translator.configure(input);
        case "config_status":
          return translator.status();
        case "translate":
          return translator.translate(
            {
              ...input,
              text:
                input.text ?? (activation.context?.kind === "text" ? activation.context.text : ""),
            },
            context,
          );
        case "cancel":
          return translator.cancel(input.requestId);
        default:
          throw new Error("Unknown dictionary/translation action");
      }
    },
    prepareStop() {
      return translator.prepareStop();
    },
    async stop() {
      await translator.stop();
      dictionary.close();
    },
  };
}
