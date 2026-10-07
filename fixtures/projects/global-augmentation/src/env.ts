declare global {
  namespace NodeJS {
    interface ProcessEnv {
      readonly APP_MODE: string;
      readonly UNREAD: string;
    }
  }
}

export const mode = process.env.APP_MODE;
