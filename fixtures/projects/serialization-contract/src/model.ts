// Classes whose instances flow into serializers, and seven whose instances do not. Nothing
// reads a member by name.

// Serialized by JSON.stringify: its properties are read, its methods and accessors are not.
export class Order {
  id = 1;
  items: Item[] = [];
  #secret = 0;

  total(): number {
    return 0;
  }

  get label(): string {
    return "order";
  }
}

// Reached through the items of an order.
export class Item {
  sku = "";
}

// Handed to console.log, outside the analysis: its properties and conversion methods.
export class Event {
  kind = "";

  toString(): string {
    return "event";
  }

  toJSON(): unknown {
    return null;
  }

  describe(): string {
    return "event";
  }
}

// Validated by a schema's parse method, which the configuration names.
export class Payload {
  body = "";
}

// Encoded by a serializer of the project's own, which the configuration names.
export class Frame {
  bytes = 0;
}

// Handed to a function of the project that hands it to JSON.stringify.
export class Message {
  text = "";
}

// Handed to a function that hands it to the one above.
export class Relayed {
  text = "";
}

// Handed to a function of the project that hands it to console.log.
export class Traced {
  step = 0;

  toString(): string {
    return "traced";
  }
}

// Handed to a function whose parameter names the members it reads.
export class Shaped {
  field = "";
}

// Serializes itself.
export class Snapshot {
  at = 0;

  save(): string {
    return JSON.stringify(this);
  }
}

// Serializes itself from a static method, where `this` is the class and not an instance.
export class Registry {
  entries = 0;

  static dump(): string {
    return JSON.stringify(this);
  }
}

// Serializes from a function expression nested in a method, whose `this` is not the instance.
export class Deferred {
  value = 0;

  later(): () => string {
    return function (this: unknown): string {
      return JSON.stringify(this);
    };
  }
}

// Serializes itself from a static block, where `this` is the class and not an instance.
export class Census {
  count = 0;

  static {
    JSON.stringify(this);
  }
}

// Serializes from a function declared in a method, whose `this` is not the instance.
export class Journal {
  entry = 0;

  write(): string {
    function render(this: unknown): string {
      return JSON.stringify(this);
    }
    return render();
  }
}

// Serializes and logs from the members of an object literal, whose `this` is the object.
export class Outline {
  depth = 0;

  view(): { render(): string; text: string } {
    return {
      render(): string {
        return JSON.stringify(this);
      },
      get text(): string {
        console.log(this);
        return "";
      },
      set text(value: string) {
        console.log(this, value);
      },
    };
  }
}

// Serializes itself from an arrow function, whose `this` is the instance.
export class Batch {
  size = 0;

  lines(items: readonly string[]): string[] {
    return items.map(() => JSON.stringify(this));
  }
}

// Handed to a function whose `this` parameter binds no argument, which hands it to JSON.stringify.
export class Bound {
  id = 0;
}

// Handed first to a rest parameter after a `this` parameter, which hands it to JSON.stringify.
export class Leading {
  id = 0;
}

// Handed second to the same rest parameter.
export class Trailing {
  id = 0;
}

// Handed to a method whose `this` parameter binds no argument, which hands it to JSON.stringify.
export class Posted {
  id = 0;
}

// Handed to JSON.stringify through Function.prototype.call, which passes its arguments on.
export class Called {
  id = 0;
}

// Handed to JSON.stringify through Function.prototype.apply, in its argument array.
export class Applied {
  id = 0;
}

// Handed to the function Function.prototype.bind returns for JSON.stringify.
export class Rebound {
  id = 0;
}

// Bound as JSON.stringify's first argument by Function.prototype.bind.
export class Prebound {
  id = 0;
}

// Handed to console.log through Function.prototype.call, outside the analysis.
export class Logged {
  kind = "";

  toString(): string {
    return "logged";
  }
}

// Handed through Function.prototype.call to a function of the project that hands it on.
export class Dispatched {
  text = "";
}

// Handed to a function expression held by a variable, whose `this` parameter binds no argument.
export class VarBound {
  id = 0;
}

// Handed nowhere.
export class Kept {
  unused = "";
}
