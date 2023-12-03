// src/schema.ts
import { makeExecutableSchema } from "graphql-tools";
import fs from 'fs';
import path from "path";

import {
  Resolver, Resolvers,
  DevelopmentStage, DevelopmentStageResolvers, DevelopmentStageType,
  Discussion, DiscussionResolvers, Document, DocumentResolvers, DocumentType, DocumentSubType,
  Project, ProjectResolvers,
  Task, TaskResolvers, ProjectStatus, Statement,
} from "../../generated/graphql.gen.js";
import { DevelopmentStageEntity, DiscussionEntity, DocumentEntity, ProjectEntity, StatementEntity, TaskEntity } from "./models/project-models.js";
import { ds } from "./db.js";
import { UserEntity } from "./models/auth.js";


const projectRepository = ds.getRepository(ProjectEntity);
const developmentStageRepository = ds.getRepository(DevelopmentStageEntity);
const discussionRepository = ds.getRepository(DiscussionEntity);
const documentRepository = ds.getRepository(DocumentEntity);
const taskRepository = ds.getRepository(TaskEntity);
const statementRepository = ds.getRepository(StatementEntity);
const userRepository = ds.getRepository(UserEntity);

const documentMapper = (document: DocumentEntity): Document => ({
  id: String(document.id), type: document.type, subType: document.subType, title: document.title, content: document.content
});
const discussionMapper = (discussion: DiscussionEntity): Discussion => ({
  id: String(discussion.id), topic: discussion.topic,
  participants: (discussion.participants || []).map((participant: UserEntity) => participant.name),
  statements: (discussion.statements || []).map((statement: StatementEntity) => statementMapper(statement)),
});
const taskMapper = (task: TaskEntity): Task => ({
  id: String(task.id), name: task.name,
  documents: (task.documents || []).map((document: DocumentEntity) => documentMapper(document)),
  discussions: (task.discussions || []).map((discussion: DiscussionEntity) => discussionMapper(discussion)),
  status: task.status,
});
const statementMapper = (statement: StatementEntity): Statement => ({
  id: String(statement.id), speaker: statement.speaker, content: statement.content
});
const developmentStageMapper = (stage: DevelopmentStageEntity): DevelopmentStage => ({
  id: String(stage.id), type: stage.type, name: stage.name,
  tasks: (stage.tasks || []).map((task: TaskEntity) => taskMapper(task)),
  // documents: (stage.documents || []).map((document: DocumentEntity) => documentMapper(document)),
  // discussions: (stage.discussions || []).map((discussion: DiscussionEntity) => discussionMapper(discussion)),
  status: stage.status,
});
const projectMapper = (project: ProjectEntity): Project => ({
  id: String(project.id), name: project.name,
  stages: (project.stages || []).map((stage: DevelopmentStageEntity) => developmentStageMapper(stage)),
  status: project.status,
});
export const resolvers: Resolvers = {
  Query: {
    projects: () => projectRepository.find().then((projects: ProjectEntity[]) => projects.map((project: ProjectEntity) => projectMapper(project))),
    project: (_, { id }) => projectRepository.findOne({ where: { id: Number(id) }, relations: ['stages'] }).then((project: ProjectEntity | null) =>
      project ? projectMapper(project) : null
    ),
    developmentStages: (_, { projectId }) => projectRepository.findOne({ where: { id: Number(projectId) }, relations: ['stages'] }).then(
      (project: ProjectEntity | null) => (project?.stages || []).map((stage: DevelopmentStageEntity) => developmentStageMapper(stage))
    ),
    developmentStage: (_, { id }) =>
      developmentStageRepository.findOne({ where: { id: Number(id) }, relations: ['documents', 'discussions', 'tasks'] }).then((stage: DevelopmentStageEntity | null) =>
        stage ? developmentStageMapper(stage) : null
      ),
    discussions: (_, { taskId }) => taskRepository.findOne({ where: { id: Number(taskId) }, relations: ['discussions'] }).then(
      (task: TaskEntity | null) => (task?.discussions || []).map((discussion: DiscussionEntity) => discussionMapper(discussion))
    ),
    discussion: (_, { id }) =>
      discussionRepository.findOne({ where: { id: Number(id) }, relations: ['statements', 'participants'] }).then((discussion: DiscussionEntity | null) =>
        discussion ? discussionMapper(discussion) : null
      ),
    documents: (_, { taskId }) => taskRepository.findOne({ where: { id: Number(taskId) }, relations: ['documents'] }).then(
      (task: TaskEntity | null) => (task?.documents || []).map((document: DocumentEntity) => documentMapper(document))
    ),
    document: (_, { id }) =>
      documentRepository.findOne({ where: { id: Number(id) } }).then((document: DocumentEntity | null) =>
        document ? documentMapper(document) : null
      ),
    tasks: (developmentStageId) => developmentStageRepository.findOne({ where: { id: Number(developmentStageId) }, relations: ['tasks'] }).then(
      (stage: DevelopmentStageEntity | null) => (stage?.tasks || []).map((task: TaskEntity) => taskMapper(task))
    ),
    task: (_, { id }) =>
      taskRepository.findOne({ where: { id: Number(id) }, relations: ['documents', 'discussions'] }).then((task: TaskEntity | null) =>
        task ? taskMapper(task) : null
      ),
  },
  Mutation: {
    createProject: (_, { name, status }) => {
      const project = new ProjectEntity();
      project.name = name;
      project.status = status;
      project.stages = [];
      return projectRepository.save(project).then((project: ProjectEntity) => projectMapper(project));
    },
    updateProject: (_, { id, name, status }) => {
      return projectRepository.findOne({ where: { id: Number(id) } }).then((project: ProjectEntity | null) => {
        if (project) {
          if (name) {
            project.name = name;
          }
          if (status) {
            project.status = status;
          }
          return projectRepository.save(project).then((project: ProjectEntity) => projectMapper(project));
        }
        return null;
      });
    },
    deleteProject: (_, { id }) => {
      return projectRepository.findOne({ where: { id: Number(id) } }).then((project: ProjectEntity | null) => {
        if (project) {
          return projectRepository.remove(project).then(() => String(id));
        }
        return null;
      });
    },
    addDevelopmentStage: (_, { projectId, type, name, status }) => {
      const stage = new DevelopmentStageEntity();
      stage.type = type;
      stage.name = name;
      stage.status = status;
      return projectRepository.findOne({ where: { id: Number(projectId) } }).then((project: ProjectEntity | null) => {
        if (project) {
          // project.stages.push(stage);
          // projectRepository.save(project);
          stage.project = project;
          return developmentStageRepository.save(stage).then((stage: DevelopmentStageEntity) => developmentStageMapper(stage));
        }
        return null;
      });
    },
    updateDevelopmentStage: (_, { id, type, name, status }) => {
      return developmentStageRepository.findOne({ where: { id: Number(id) } }).then((stage: DevelopmentStageEntity | null) => {
        if (stage) {
          if (type) {
            stage.type = type;
          }
          if (name) {
            stage.name = name;
          }
          if (status) {
            stage.status = status;
          }
          return developmentStageRepository.save(stage).then((stage: DevelopmentStageEntity) => developmentStageMapper(stage));
        }
        return null;
      });
    },
    deleteDevelopmentStage: (_, { id }) => {
      return developmentStageRepository.findOne({ where: { id: Number(id) } }).then((stage: DevelopmentStageEntity | null) => {
        if (stage) {
          return developmentStageRepository.remove(stage).then(() => String(id));
        }
        return null;
      });
    },
    addTask: (_, { developmentStageId, name, status }) => {
      const task = new TaskEntity();
      task.name = name;
      task.status = status;
      return developmentStageRepository.findOne({ where: { id: Number(developmentStageId) } }).then((stage: DevelopmentStageEntity | null) => {
        if (stage) {
          task.stage = stage;
          return taskRepository.save(task).then((task: TaskEntity) => taskMapper(task));
        }
        return null;
      });
    },
    updateTask: (_, { id, name, status }) => {
      return taskRepository.findOne({ where: { id: Number(id) } }).then((task: TaskEntity | null) => {
        if (task) {
          if (name) {
            task.name = name;
          }
          if (status) {
            task.status = status;
          }
          return taskRepository.save(task).then((task: TaskEntity) => taskMapper(task));
        }
        return null;
      });
    },
    deleteTask: (_, { id }) => {
      return taskRepository.findOne({ where: { id: Number(id) } }).then((task: TaskEntity | null) => {
        if (task) {
          return taskRepository.remove(task).then(() => String(id));
        }
        return null;
      });
    },
    addDocument: (_, { taskId, type, subType, title, content, status }) => {
      const document = new DocumentEntity();
      document.type = type;
      document.subType = subType;
      document.title = title;
      document.content = content;
      document.status = status;
      return taskRepository.findOne({ where: { id: Number(taskId) } }).then((task: TaskEntity | null) => {
        if (task) {
          // document.task = task;
          return documentRepository.save(document).then((document: DocumentEntity) => documentMapper(document));
        }
        return null;
      });
    },
    updateDocument: (_, { id, type, subType, title, content, status }) => {
      return documentRepository.findOne({ where: { id: Number(id) } }).then((document: DocumentEntity | null) => {
        if (document) {
          if (type) {
            document.type = type;
          }
          if (subType) {
            document.subType = subType;
          }
          if (title) {
            document.title = title;
          }
          if (content) {
            document.content = content;
          }
          if (status) {
            document.status = status;
          }
          return documentRepository.save(document).then((document: DocumentEntity) => documentMapper(document));
        }
        return null;
      });
    },
    deleteDocument: (_, { id }) => {
      return documentRepository.findOne({ where: { id: Number(id) } }).then((document: DocumentEntity | null) => {
        if (document) {
          return documentRepository.remove(document).then(() => String(id));
        }
        return null;
      });
    },
    addDiscussion: (_, { taskId, topic, participants }) => {
      const discussion = new DiscussionEntity();
      discussion.topic = topic;
      return userRepository
        .createQueryBuilder("users")
        .where("users.id IN (:...participants)", { participants })
        .getMany()
        .then((users: UserEntity[]) => discussion.participants = users)
        .then(() => taskRepository.findOne({ where: { id: Number(taskId) } }).then((task: TaskEntity | null) => {
          if (task) {
            task.discussions.push(discussion);
            taskRepository.save(task);
            // discussion.task = task;
            return discussionRepository.save(discussion).then((discussion: DiscussionEntity) => discussionMapper(discussion));
          }
          return null;
        }));
    },
    updateDiscussion: (_, { id, topic, participants }) => {
      return discussionRepository.findOne({ where: { id: Number(id) } }).then((discussion: DiscussionEntity | null) => {
        if (discussion) {
          if (topic) {
            discussion.topic = topic;
          }
          if (participants) {
            // discussion.participants = participants;
          }
          return discussionRepository.save(discussion).then((discussion: DiscussionEntity) => discussionMapper(discussion));
        }
        return null;
      });
    },
    deleteDiscussion: (_, { id }) => {
      return discussionRepository.findOne({ where: { id: Number(id) } }).then((discussion: DiscussionEntity | null) => {
        if (discussion) {
          return discussionRepository.remove(discussion).then(() => String(id));
        }
        return null;
      });
    },
    addStatement: (_, { discussionId, speaker, content }) => {
      const statement = new StatementEntity();
      statement.speaker = speaker;
      statement.content = content;
      return discussionRepository.findOne({ where: { id: Number(discussionId) } }).then((discussion: DiscussionEntity | null) => {
        if (discussion) {
          statement.discussion = discussion;
          return statementRepository.save(statement).then((statement: StatementEntity) => statementMapper(statement));
        }
        return null;
      });
    },
    updateStatement: (_, { id, speaker, content }) => {
      return statementRepository.findOne({ where: { id: Number(id) } }).then((statement: StatementEntity | null) => {
        if (statement) {
          if (speaker) {
            statement.speaker = speaker;
          }
          if (content) {
            statement.content = content;
          }
          return statementRepository.save(statement).then((statement: StatementEntity) => statementMapper(statement));
        }
        return null;
      });
    },
    deleteStatement: (_, { id }) => {
      return statementRepository.findOne({ where: { id: Number(id) } }).then((statement: StatementEntity | null) => {
        if (statement) {
          return statementRepository.remove(statement).then(() => String(id));
        }
        return null;
      });
    },
  }

};
// type Mutation {
//   # プロジェクトに関するミューテーション
//   createProject(name: String!, status: ProjectStatus!): Project
//   updateProject(id: ID!, name: String, status: ProjectStatus): Project
//   deleteProject(id: ID!): ID

//   # 開発ステージに関するミューテーション
//   addDevelopmentStage(
//     projectId: ID!
//     type: DevelopmentStageType!
//     name: String!
//     status: ProjectStatus!
//   ): DevelopmentStage
//   updateDevelopmentStage(
//     id: ID!
//     type: DevelopmentStageType
//     name: String
//     status: ProjectStatus
//   ): DevelopmentStage
//   deleteDevelopmentStage(id: ID!): ID

//   # タスクに関するミューテーション
//   addTask(developmentStageId: ID!, name: String!, status: ProjectStatus!): Task
//   updateTask(id: ID!, name: String, status: ProjectStatus): Task
//   deleteTask(id: ID!): ID

//   # ドキュメントに関するミューテーション
//   addDocument(
//     taskId: ID!
//     type: DocumentType!
//     subType: DocumentSubType!
//     title: String!
//     content: String!
//     status: ProjectStatus!
//   ): Document
//   updateDocument(
//     id: ID!
//     type: DocumentType
//     subType: DocumentSubType
//     title: String
//     content: String
//     status: ProjectStatus
//   ): Document
//   deleteDocument(id: ID!): ID

//   # ディスカッションに関するミューテーション
//   addDiscussion(
//     taskId: ID!
//     topic: String!
//     participants: [String]!
//   ): Discussion
//   updateDiscussion(id: ID!, topic: String, participants: [String]): Discussion
//   deleteDiscussion(id: ID!): ID

// # ステートメントに関するミューテーション
// addStatement(discussionId: ID!, speaker: String!, content: String!): Statement
// updateStatement(id: ID!, speaker: String, content: String): Statement
// deleteStatement(id: ID!): ID
// }


// type Statements {
//   id: ID!
//   speaker: String
//   content: String
// }

// type Project {
//   id: ID!
//   name: String
//   stages: [DevelopmentStage]
//   status: ProjectStatus
// }

// type DevelopmentStage {
//   id: ID!
//   type: DevelopmentStageType
//   name: String
//   documents: [Document]
//   discussions: [Discussion]
//   tasks: [Task]
//   status: ProjectStatus
// }

// type Task {
//   id: ID!
//   name: String
//   documents: [Document]
//   discussions: [Discussion]
//   status: ProjectStatus
// }

// type Document {
//   id: ID!
//   type: DocumentType
//   subType: DocumentSubType
//   title: String
//   content: String
//   status: ProjectStatus
// }

// type Discussion {
//   id: ID!
//   topic: String
//   participants: [String]
//   statements: [Statements]
// }

// type Query {
//   # プロジェクトの読み取りクエリ
//   project(id: ID!): Project
//   projects: [Project]
//   developmentStage(id: ID!): DevelopmentStage
//   developmentStages(projectId: ID!): [DevelopmentStage]
//   task(id: ID!): Task
//   tasks(developmentStageId: ID!): [Task]
//   document(id: ID!): Document
//   documents(taskId: ID!): [Document]
//   discussion(id: ID!): Discussion
//   discussions(taskId: ID!): [Discussion]
// }


// const queryType = new GraphQLObjectType({
//   name: "RootQueryType",
//   fields: {
//     hello: {
//       type: GraphQLString,
//       resolve: () => "Hello, world!",
//     },
//   },
// });

// export const schema = new GraphQLSchema({ query: queryType });


// TODO ファイルの読み込みはどうするか要検討。src配下は良くなさそう。
const typeDefs = fs.readFileSync(path.join('./src/graphql/schema.graphql'), 'utf8');

export const schema = makeExecutableSchema({
  typeDefs,
  resolvers: resolvers,
});
