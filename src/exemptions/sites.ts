/**
 * The one walk of a project's own files every detector shares: its calls and the class
 * `this` stands for at each, its classes, the values it hands to positions typed by
 * their context, its functions' parameters, its decorated declarations and its
 * assignments to properties. The walk reads syntax only; what a call invokes through a
 * method of `Function.prototype` asks the checker, once per project, at the first
 * detector that needs it.
 */

import {
  isArrowFunction,
  isBinaryExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isVariableDeclaration,
  ModifierFlags,
  SyntaxKind,
  type CallExpression,
  type ClassLikeDeclaration,
  type Expression,
  type Node,
  type ParameterDeclaration,
} from "@typescript/native/ast";
import { handedOn, valuesOf } from "../index/values.ts";
import { isParameterProperty, nodeKey, type Inventory } from "../inventory.ts";
import type { ProjectView } from "../session.ts";
import { parenthesesRemoved } from "../unwrap.ts";
import { decoratorsOf, invocations, type Invocations } from "./calls.ts";

/** One call of the project's own files, and the class `this` is a value of where it is written. */
export interface CallSite {
  readonly call: CallExpression;
  /** The inventory's identifier of the class, where `this` is an instance of one. */
  readonly self: string | undefined;
}

/** One class the inventory holds, declared or written as an expression. */
interface ClassSite {
  readonly id: string;
  readonly node: ClassLikeDeclaration;
}

/** One value the project hands to a position the checker types from its context. */
interface FlowSite {
  readonly value: Expression;
  /** The class `this` stands for, where the value is `this` inside an instance member. */
  readonly self: string | undefined;
}

/** One identifier-named parameter of a function, method or function-valued variable of the project. */
export interface ParameterSite {
  /** The inventory's identifier of the function's declaration. */
  readonly fn: string;
  /** Its place among the arguments a call binds, a `this` parameter taking none. */
  readonly index: number;
  readonly rest: boolean;
  readonly name: Node;
}

/** One assignment of a value to a property a key written as a name or a string names. */
interface StoreSite {
  readonly store: Expression;
  readonly receiver: Expression;
  readonly key: string;
  readonly value: Expression;
}

/** The property one assignment's left side names on its receiver, where a written key names it. */
function storeOf(node: Node): StoreSite | undefined {
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken) {
    return undefined;
  }
  const left = parenthesesRemoved(node.left);
  if (isPropertyAccessExpression(left) && isIdentifier(left.name)) {
    return { store: node, receiver: left.expression, key: left.name.text, value: node.right };
  }
  if (
    isElementAccessExpression(left) &&
    (isStringLiteral(left.argumentExpression) ||
      isNoSubstitutionTemplateLiteral(left.argumentExpression))
  ) {
    return {
      store: node,
      receiver: left.expression,
      key: left.argumentExpression.text,
      value: node.right,
    };
  }
  return undefined;
}

/** One declaration the inventory holds that carries a decorator. */
interface DecoratedSite {
  readonly id: string;
  readonly node: Node;
}

/** What one walk of a project's own files found. */
interface Walked {
  readonly calls: readonly CallSite[];
  readonly classes: readonly ClassSite[];
  readonly flows: readonly FlowSite[];
  readonly parameters: readonly ParameterSite[];
  readonly decorated: readonly DecoratedSite[];
  /** The assignments to a property a written key names. */
  readonly stores: readonly StoreSite[];
  /** The parameter properties the inventory holds, by identifier. */
  readonly parameterProperties: ReadonlySet<string>;
  /** The class properties whose declaration writes an initializer, by identifier. */
  readonly initialized: ReadonlySet<string>;
}

/** Whether one node declares a static member, whose `this` is the class itself. */
function isStatic(node: Node): boolean {
  const flags = (node as { readonly modifierFlags?: number }).modifierFlags ?? 0;
  return (flags & ModifierFlags.Static) !== 0;
}

/**
 * Whether one node opens a body whose `this` is no instance of the enclosing class: a
 * function that is not an arrow, a static block, a static member, and a method or an
 * accessor of an object literal, whose `this` is the literal.
 */
function resetsThis(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isClassStaticBlockDeclaration(node) ||
    isStatic(node) ||
    ((isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
      isObjectLiteralExpression(node.parent))
  );
}

/** The parameters and declaring node of one function-like declaration of the project. */
function functionOf(
  node: Node,
): { readonly declared: Node; readonly parameters: readonly ParameterDeclaration[] } | undefined {
  if (
    isFunctionDeclaration(node) ||
    (isMethodDeclaration(node) && !isObjectLiteralExpression(node.parent))
  ) {
    return { declared: node, parameters: node.parameters };
  }
  if (
    isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))
  ) {
    return { declared: node, parameters: node.initializer.parameters };
  }
  return undefined;
}

function walk<Brand>(project: ProjectView<Brand>, held: Inventory): Walked {
  const calls: CallSite[] = [];
  const classes: ClassSite[] = [];
  const flows: FlowSite[] = [];
  const parameters: ParameterSite[] = [];
  const decorated: DecoratedSite[] = [];
  const stores: StoreSite[] = [];
  const parameterProperties = new Set<string>();
  const initialized = new Set<string>();
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node, self: string | undefined): void => {
      const id = held.declarations.get(nodeKey(file, node));
      let inner = self;
      if (isClassDeclaration(node) || isClassExpression(node)) {
        inner = id;
        if (id !== undefined) {
          classes.push({ id, node });
        }
      } else if (resetsThis(node)) {
        inner = undefined;
      }
      if (id !== undefined) {
        if (isParameterProperty(node)) {
          parameterProperties.add(id);
        }
        if (decoratorsOf(node).length > 0) {
          decorated.push({ id, node });
        }
        if (isPropertyDeclaration(node) && node.initializer !== undefined) {
          initialized.add(id);
        }
      }
      if (node.kind === SyntaxKind.CallExpression) {
        calls.push({ call: node as CallExpression, self: inner });
      }
      const store = storeOf(node);
      if (store !== undefined) {
        stores.push(store);
      }
      for (const written of handedOn(node)) {
        for (const value of valuesOf(written)) {
          flows.push({ value, self: value.kind === SyntaxKind.ThisKeyword ? inner : undefined });
        }
      }
      const fn = functionOf(node);
      const fnId = fn === undefined ? undefined : held.declarations.get(nodeKey(file, fn.declared));
      if (fn !== undefined && fnId !== undefined) {
        fn.parameters
          .filter((parameter) => !(isIdentifier(parameter.name) && parameter.name.text === "this"))
          .forEach((parameter, index) => {
            if (isIdentifier(parameter.name)) {
              parameters.push({
                fn: fnId,
                index,
                rest: parameter.dotDotDotToken !== undefined,
                name: parameter.name,
              });
            }
          });
      }
      node.forEachChild((child) => {
        visit(child, inner);
      });
    };
    file.forEachChild((child) => {
      visit(child, undefined);
    });
  }
  return {
    calls,
    classes,
    flows,
    parameters,
    decorated,
    stores,
    parameterProperties,
    initialized,
  };
}

/** One project's sites, walked at the first detector that reads them. */
export interface ProjectSites extends Walked {
  /** What each call invokes, a call through `call`, `apply` or `bind` included. */
  readonly invocations: Invocations;
}

/** The sites of one project's own files, each walk and each checker question made once. */
export function projectSites<Brand>(project: ProjectView<Brand>, held: Inventory): ProjectSites {
  let walked: Walked | undefined;
  let invoked: Invocations | undefined;
  const sites = (): Walked => (walked ??= walk(project, held));
  return {
    get calls() {
      return sites().calls;
    },
    get classes() {
      return sites().classes;
    },
    get flows() {
      return sites().flows;
    },
    get parameters() {
      return sites().parameters;
    },
    get decorated() {
      return sites().decorated;
    },
    get stores() {
      return sites().stores;
    },
    get parameterProperties() {
      return sites().parameterProperties;
    },
    get initialized() {
      return sites().initialized;
    },
    get invocations() {
      return (invoked ??= invocations(
        project,
        sites().calls.map((one) => one.call),
      ));
    },
  };
}
