// The members the templates and the lookups name. Nothing in the program reads any of
// them through a name the reference pass follows.

export class Page {
  title = "home";
  private body = "text";
  #secret = "kept";
  subtitle = "none";
  draft = "";
  static count = 0;
}

export class Server {
  reload(): void {}

  refresh(): void {}

  restart(): void {}

  private hidden(): void {}

  #token = "kept";
}
