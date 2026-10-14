import { each } from "./callbacks.js";
import { spy } from "./helper.js";

describe("a", () => {
  const unread = spy();
  each([], () => undefined);
});
