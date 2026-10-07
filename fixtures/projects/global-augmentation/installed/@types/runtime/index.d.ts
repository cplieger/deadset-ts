declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface Process {
    readonly env: ProcessEnv;
  }
}

declare var process: NodeJS.Process;
