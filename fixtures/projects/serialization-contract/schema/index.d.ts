// A schema validator's declarations, as its package publishes them.

export declare class Schema<T> {
  parse(data: unknown): T;
}

export declare function object<T>(shape: T): Schema<T>;
