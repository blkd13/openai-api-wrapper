import Parser, { SyntaxNode } from "tree-sitter";
import TreeSitterSql from "tree-sitter-sql";
import { boolean } from "yargs";

export class SqlSection {
  constructor(
    public commentBefore: string,
    public commentAfter: string,
    public code: string[]
  ) {}
}

export function parseSqlForSQL(code: string): SqlSection {
  const parser = new Parser();
  parser.setLanguage(TreeSitterSql);
  const tree = parser.parse(code);
  const commentNodes = findNodes(tree.rootNode, "comment", 1);
  let comment = "";
  //   うまくいかなかったので、却下
  //   tree.rootNode.children.forEach((node) => {
  //     if (node.type != "comment") {
  //       sqlCode += node.text + "\n";
  //     }
  //   });
  const sql = code.split("\n").reduce((prev, curr) => {
    if (curr.startsWith("/*")) {
    } else {
      prev += curr + "\n";
    }
    return prev;
  }, "");
  const sqlCode: string[] = [];
  sqlCode.push(sql);
  if (commentNodes) {
    comment = commentNodes.reduce((prev, curr) => {
      prev += curr.text + "\n";
      return prev;
    }, "");
  }
  return new SqlSection(comment, "", sqlCode);
}

export function parseSqlForDML(code: string): SqlSection {
  const parser = new Parser();
  parser.setLanguage(TreeSitterSql);
  const tree = parser.parse(code);
  const commentBefore: string[] = [];
  const commentAfter: string[] = [];
  let boolAfter = false;
  tree.rootNode.children.forEach((node) => {
    if (node.type == "comment") {
      if (boolAfter) {
        commentAfter.push(node.text);
      } else {
        commentBefore.push(node.text);
      }
    }
  });
  const sql: string[] = [];
  let count = -1;
  let countSql = 0;
  let truncateText = "";
  code.split("\n").forEach((text) => {
    if (text.trim().startsWith("--")) {
    } else {
      if (text.trim().startsWith("TRUNCATE")) {
        truncateText = text;
      } else if (text.trim().startsWith("INSERT")) {
        if (countSql < 4) {
          countSql++;
          sql[count] += "\n" + text;
        } else {
          count++;
          countSql = 0;
          sql[count] = text;
        }
      } else {
        sql[count] += "\n" + text;
      }
    }
  });
  sql[0] = truncateText + "\n" + sql[0];
  return new SqlSection(commentBefore.join("\n"), commentAfter.join("\n"), sql);
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
