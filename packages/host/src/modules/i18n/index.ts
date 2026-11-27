import { en } from "./en.js";

export type Language = "zh" | "en";

export type Translator = (text: string, params?: Record<string, string | number>) => string;

/**
 * 造一个翻译函数。语言在调用那一刻现读，所以配置改了不需要刷新任何东西
 * —— 把语言存成字段，就多一份要同步的快照。
 *
 * 用在产生文案的地方：把字符串字面量包一次。不要在出口遍历对象替换文本——那会变成
 * 一层谁也说不清行为的递归。
 */
export function createTranslator(readLanguage: () => Language): Translator {
  return (text, params) => {
    const template = readLanguage() === "en" ? (en[text] ?? text) : text;
    return params === undefined ? template : fill(template, params);
  };
}

function fill(template: string, params: Record<string, string | number>): string {
  // 缺参数时留下占位符原样：写成「undefined」会把「宿主少传了一个参数」伪装成一句读得通的话。
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}
