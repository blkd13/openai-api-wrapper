declare module 'dotenv-override' {
  interface DotenvOverrideConfigOptions {
    override?: boolean;
  }

  function config(options?: DotenvOverrideConfigOptions): void;

  export { config };
}

