// The interfaces the classes' values reach. Sized carries a member it inherits.

export interface Shape {
  area(): number;
}

export interface Named {
  label(): string;
}

export interface Sized extends Named {
  size(): number;
}
