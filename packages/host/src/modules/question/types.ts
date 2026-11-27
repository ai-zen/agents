/**
 * 题 = 一张表单。形状照抄 MCP 的 elicitation（spec 2026-07-28 的 `requestedSchema`）：
 * 扁平对象，属性只能是字符串/数字/布尔/单选枚举，数组只允许「多选枚举」。没有嵌套对象。
 *
 * ## 为什么不用「一句话 + 若干候选」
 *
 * 候选列表只能表达单选，而同一个机制还要接外部服务器发来的 elicitation —— 那边要的是「几个字段
 * 一起问」。两套形状并存的话，面板、事件、无线协议各要写两遍，而两边说的是同一件事。所以这一格
 * 只有一种形状，宿主自己的题（交接三选一）也写成「一个单选枚举字段」。
 *
 * 作答是三态，与 spec 一致：`accept` 带数据、`decline` 是显式拒绝、`cancel` 是关掉没作答
 * （Esc / Ctrl+C）。「关掉等于哪个值」不再由题自己声明 —— 那是消费者的事：交接那一处拿到
 * `cancel` 就当「不交接」，而外部服务器拿到 `cancel` 就照 spec 回它一个 cancel。
 *
 * 题只活在内存里（没有表、不落库）：产生它的那一刻是哪一种语言，它就一直是用那一种语言写的。
 */

/** 表单里一格允许的类型：spec 的 `requestedSchema` 子集的声明式影子 */
export type FormField =
  | {
      readonly type: "string";
      readonly title?: string;
      readonly description?: string;
      readonly default?: string;
      /** 只认 spec 列出的这四个；别的格式面板不负责校验 */
      readonly format?: "email" | "uri" | "date" | "date-time";
      readonly minLength?: number;
      readonly maxLength?: number;
      /** 单选枚举：给了它就只能是这几个值之一 */
      readonly enum?: readonly string[];
      /** 与 `enum` 一一对应的显示名；缺了就用值本身 */
      readonly enumNames?: readonly string[];
    }
  | {
      readonly type: "number" | "integer";
      readonly title?: string;
      readonly description?: string;
      readonly default?: number;
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: "boolean";
      readonly title?: string;
      readonly description?: string;
      readonly default?: boolean;
    }
  | {
      /** 多选枚举：spec 里唯一允许的数组形状 */
      readonly type: "array";
      readonly title?: string;
      readonly description?: string;
      readonly items: {
        readonly type: "string";
        readonly enum: readonly string[];
        readonly enumNames?: readonly string[];
      };
      readonly default?: readonly string[];
      readonly minItems?: number;
      readonly maxItems?: number;
    };

/** 一道题要问的那张表：扁平对象，`required` 是必须填的字段名 */
export interface FormSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, FormField>>;
  readonly required?: readonly string[];
}

/** 作答的三种去处（与 MCP 的 `action` 一一对应） */
export type FormAction = "accept" | "decline" | "cancel";

/** 一次作答：`accept` 才带 `content`，另两种它没有意义 */
export interface FormAnswer {
  readonly action: FormAction;
  /** 字段名 → 值；只有 `accept` 有这一格 */
  readonly content?: Readonly<Record<string, unknown>>;
}

/** 一道挂着的题 */
export interface FormRequest {
  readonly id: string;
  readonly sessionId: string;
  /** 题干：产生时按当前语言渲染好的成品句 */
  readonly message: string;
  readonly requestedSchema: FormSchema;
  /** 挡住这段会话继续跑，缺省就是挡（宿主自己的行为，MCP 那边没有这一格） */
  readonly blocking: boolean;
  /**
   * 这道题允许用户交哪几态；缺省三态齐全。
   *
   * 出题方决定它，因为只有出题方知道「拒绝」在这道题里有没有意义：交接那句问的是「用哪种方式」，
   * 「不交接」本来就是枚举里的一项，再给一个「拒绝」按钮是两个入口说同一件事；而一个即将删数据的
   * 确认，`decline` 有意义、「默默关掉」没有。
   *
   * 这是**面板的画法**，不是新的作答语义：登记的仍只有 accept / decline / cancel，客户端只会从
   * 这几态里挑一个交回来（不在表里的那一态在这里被拒，见 `QuestionRegistry.answer`）。
   */
  readonly actions?: readonly FormAction[];
  readonly createdAt: number;
}
