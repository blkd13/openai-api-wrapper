import { Utils } from "../../common/utils.js";
import Parser, { SyntaxNode } from "tree-sitter";
import TreeSitterCSharp from "tree-sitter-c-sharp";

export class CsharpSection {
  constructor(
    public usingList: string[],
    public namespace: string,
    public className: string,
    public sourceCode: string, // public isPartial: boolean, // public hasBaseList: boolean
    public targetFilePath: string
  ) {}
}

// TODO:さらに細分化したい場合に使う
const chunkSize = 500;
export function parseCsharpCode(
  code: string,
  targetFilePath: string
): CsharpSection[] {
  const parser = new Parser();
  parser.setLanguage(TreeSitterCSharp);
  const tree = parser.parse(code);
  // using.type ->　using_directive
  const usingNodes = findNodes(tree.rootNode, "using_directive");
  const usingList = usingNodes.map((node) => node.text);

  // namespace.type -> namespace_declaration
  const namespaceNodes = findNodes(tree.rootNode, "namespace_declaration", 1);
  const csharpSections: CsharpSection[] = [];
  if (namespaceNodes) {
    // namespace複数あるかも　を考慮
    namespaceNodes.forEach((namespaceNode) => {
      const namespaceName =
        findNodes(namespaceNode, "namespace", 2)[0].text +
        " " +
        findNodes(namespaceNode, "qualified_name", 2)[0].text;
      const declarationNode = findNodes(
        namespaceNode,
        "declaration_list",
        1
      )[0];
      // TODO classの中にclassを定義するパターンを考慮するか？
      const classNodes = findNodes(declarationNode, "class_declaration", 1);
      // namespace内にclass定義以外がないことを確認
      declarationNode.children.forEach((node) => {
        if (["class_declaration", "{", "}", "comment"].includes(node.type)) {
        } else {
          console.log("[W] class定義以外があるよ:" + targetFilePath);
          console.log(node.type);
          console.log("---------------");
        }
      });
      // class単位に分割
      classNodes.forEach((node) => {
        // TODO partial classを分ける
        // node.children.forEach((node) => {
        // if (node.type == "declaration_list") {
        //   if (node.children) {
        //     node.children.forEach((child) => {
        //       console.log(child.type);
        //       console.log(child.text);
        //       console.log("----------------------");
        //     });
        //   } else {
        //     console.log("hoge");
        //   }
        // }
        // });
        // extends.type -> base_list

        const classNameNode = findNodes(node, "identifier", 1)[0];
        if (classNameNode) {
          csharpSections.push(
            new CsharpSection(
              usingList,
              namespaceName,
              classNameNode.text,
              node.text,
              targetFilePath
            )
          );
        } else {
          console.log("No class identifier");
        }
      });
    });
  } else {
    console.log("[W] namespace定義がないよ:" + targetFilePath);
  }

  return csharpSections;
}

function findNodes(
  node: SyntaxNode,
  type: string,
  depth: number = -1
): SyntaxNode[] {
  let nodes = [];
  if (node.type === type) {
    nodes.push(node);
  }
  if (depth != 0) {
    for (const child of node.children) {
      nodes = nodes.concat(findNodes(child, type, depth - 1));
    }
  }
  return nodes;
}

export function getSection(c: CsharpSection): string {
  return (
    c.usingList.join("\n") +
    "\n" +
    c.namespace +
    "\n" +
    "{" +
    "\n" +
    c.sourceCode
      .split("\n")
      .map((line) => "\t" + line)
      .join("\n") +
    "\n" +
    "}"
  );
}
