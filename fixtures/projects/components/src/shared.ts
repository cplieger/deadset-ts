// Two dead functions over one dead helper they share and one only the first calls.

export function left(): number {
  return sharedHelper() + onlyLeft();
}

export function right(): number {
  return sharedHelper();
}

function sharedHelper(): number {
  return 1;
}

function onlyLeft(): number {
  return 2;
}
