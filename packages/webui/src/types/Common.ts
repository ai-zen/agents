export enum FormMode {
  Create = "create",
  Edit = "edit",
}

export type PickRequired<T, K extends keyof T = any> = Partial<T> &
  Required<Pick<T, K>>;
