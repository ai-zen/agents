// Type definitions for terminal-kit
declare module 'terminal-kit' {
  import { EventEmitter } from 'events';

  export interface Terminal {
    width: number;
    height: number;
    (str: string): void;
    createDocument(): Document;
    on(event: string, listener: (...args: any[]) => void): this;
    grabInput(options?: { mouse?: string } | boolean): Promise<void>;
    hideCursor(hide: boolean): void;
    styleReset(): void;
    fullscreen(options: boolean): void;
    focusInput(el: Element): void;
    moveTo(x: number, y: number): void;
    blue(str: string): string;
    green(str: string): string;
    yellow(str: string): string;
    red(str: string): string;
    gray(str: string): string;
    cyan(str: string): string;
    magenta(str: string): string;
    bold: { (str: string): string };
  }

  export interface Element {
    on(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): void;
    draw(): void;
    setContent(content: string, hasMarkup?: boolean, noDraw?: boolean): void;
    focus(): void;
    resize(options: { width?: number; height?: number; x?: number; y?: number }): void;
    parent: Document | Element;
    outputX: number;
    outputY: number;
    outputWidth: number;
    outputHeight: number;
    hasFocus: boolean;
  }

  export interface Document extends Element {
    giveFocusTo(element: Element, type?: string): void;
    draw(): void;
  }

  export interface TextBox extends Element {
    textAttr: any;
    scrollable: boolean;
    hasVScrollBar: boolean;
    scrollY: number;
    content: string;
    appendContent(content: string, noDraw?: boolean): void;
    appendLog(content: string, noDraw?: boolean): void;
    prependContent(content: string, noDraw?: boolean): void;
    setContent(content: string, hasMarkup?: boolean, noDraw?: boolean): void;
    scrollToBottom(noDraw?: boolean): void;
    getContent(): string;
  }

  export interface EditableTextBox extends TextBox {
    value: string;
    getValue(): string;
    setValue(value: string, noDraw?: boolean): void;
    on(event: 'submit', listener: (value: string) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export interface InlineInput extends EditableTextBox {
    history?: string[];
    autoComplete?: string[] | Function;
    placeholder?: string;
    disabled?: boolean;
    cancelable?: boolean;
    submitted?: boolean;
    canceled?: boolean;
    noEmpty?: boolean;
    setSizeAndPosition(options: { width?: number; height?: number; x?: number; y?: number }): void;
  }

  export interface TextBoxOptions {
    parent?: Document | Element;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    content?: string;
    contentHasMarkup?: boolean;
    scrollable?: boolean;
    hasVScrollBar?: boolean;
    hasHScrollBar?: boolean;
    wordWrap?: boolean;
    lineWrap?: boolean;
    hiddenContent?: boolean;
    attr?: any;
    textAttr?: any;
    voidAttr?: any;
    label?: string;
    labelAttr?: any;
    borderAttr?: any;
    borderType?: 'line' | 'dotted' | 'dashed' | 'double' | 'none';
    keyBindings?: Record<string, string>;
    inputAttr?: any;
    noDraw?: boolean;
    value?: string;
    firstLineRightShift?: number;
    inputFocus?: boolean;
  }

  export interface ButtonOptions {
    parent?: Document | Element;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    content?: string;
    contentHasMarkup?: boolean;
  }

  export interface Button extends Element {
    on(event: 'click', listener: (data: { x: number; y: number }) => void): this;
  }

  export interface BaseMenuOptions {
    parent?: Document | Element;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    items: Array<{ content: string; value: string }>;
  }

  export interface LayoutOptions {
    parent?: Document | Element;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }

  export const terminal: Terminal;
  export const realTerminal: Terminal;
  export const Terminal: new () => Terminal;
  export function createTerminal(): Terminal;
  
  export const TextBox: new (options: TextBoxOptions) => TextBox;
  export const EditableTextBox: new (options: TextBoxOptions) => EditableTextBox;
  export const InlineInput: new (options: TextBoxOptions & { history?: string[]; autoComplete?: string[] | Function; placeholder?: string; noEmpty?: boolean; cancelable?: boolean; }) => InlineInput;
  export const Document: new (options?: any) => Document;
}

declare module 'terminal-kit/Terminal' {
  import { Terminal } from 'terminal-kit';
  export = Terminal;
}
