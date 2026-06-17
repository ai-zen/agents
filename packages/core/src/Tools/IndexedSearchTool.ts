import { AgentNS } from "../AgentNS.js";
import { PickRequired } from "../Common.js";
import { FunctionCallContext } from "../FunctionCallContext.js";
import { Tool } from "../Tool.js";

export interface IndexedSearchEntry {
  keywords: string[];
  text: string;
}

export class IndexedSearchTool implements Tool {
  type: "function";
  function: AgentNS.FunctionDefine;
  entries: IndexedSearchEntry[];

  constructor(options: PickRequired<IndexedSearchTool, "entries">) {
    this.type = options.type ?? "function";
    this.entries = options.entries ?? [];
    this.function = {
      name: "indexedSearch",
      description: `You can use this function to query the following relevant information`,
      parameters: {
        type: "object",
        properties: {
          keywords: {
            description: "Enter the keywords you want to search",
            type: "array",
            items: {
              enum: Array.from(
                new Set(options.entries.map((x) => x.keywords).flat())
              ),
            },
          },
        },
      },
    };
  }

  async exec(ctx: FunctionCallContext) {
    // GPT may mistakenly input a string instead of an array when there is only one keyword.
    const keywords: string[] =
      ctx.parsed_args.keywords instanceof Array
        ? ctx.parsed_args.keywords
        : [ctx.parsed_args.keywords];

    const results = new Set<IndexedSearchEntry>();

    // Keep only useful fields.
    const entries = this.entries.map((x) => ({
      keywords: x.keywords,
      text: x.text,
    }));

    entries.forEach((entry) => {
      if (entry.keywords.some((keyword) => keywords.includes(keyword))) {
        results.add(entry);
      }
    });

    return JSON.stringify(Array.from(results));
  }
}
