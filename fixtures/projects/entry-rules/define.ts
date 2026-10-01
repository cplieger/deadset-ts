// The two configuration helpers the configuration files call, standing in for the
// ones each tool's package exports.

export function defineConfig<T>(config: T): T {
  return config;
}

export function mergeConfig<T, U>(base: T, override: U): T & U {
  return { ...base, ...override };
}
