import { registry } from "lib";

declare module "lib" {
  namespace Plugins {
    interface Registry {
      search(): void;
    }
  }
}

registry.search();
