// A dependency-injection container's declarations, as its package publishes them.

export declare class Container {
  bind(target: unknown): Container;
}

export declare function inject(token: string): PropertyDecorator & ParameterDecorator;

export declare function Module(options: { readonly providers: readonly unknown[] }): ClassDecorator;
