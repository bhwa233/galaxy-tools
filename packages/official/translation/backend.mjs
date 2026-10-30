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
      if (Object.hasOwn(input, "hostConfiguration"))
        await translator.useConfiguration(input.hostConfiguration);
      const action =
        input.action ?? (activation.commandId === "translate" ? "translate" : "search");
      switch (action) {
        case "search": {
          const query = input.query ?? (activation.context?.kind === "text" ? activation.context.text : "");
          const result = dictionary.search(query, input.limit ?? 10);
          if (input.recordHistory === true && result.items.length)
            await translator.rememberDictionary(query).catch(() => {});
          return result;
        }
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
        case "history_list":
          return translator.listHistory();
        case "history_delete":
          return translator.deleteHistory(input.id);
        case "history_clear":
          return translator.clearHistory();
        case "dictionary_history_list":
          return translator.listDictionaryHistory();
        case "dictionary_history_delete":
          return translator.deleteDictionaryHistory(input.query);
        case "dictionary_history_clear":
          return translator.clearDictionaryHistory();
        case "preferences_get":
          return translator.getPreferences();
        case "preferences_set":
          return translator.setPreferences(input);
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
