
// export interface ProjectDocument {
//     id: number;
//     projectId: number;
//     documentId: number;
// }

// export interface Document {
//     id: number;
//     type: DocumentType;
//     subType: DocumentSubType;
//     title: string;
//     content: string;
//     status: ProjectStatus;
// }

// export interface Discussion {
//     id: number;
//     topic: string;
//     participants: string[];
//     messages: Statements[];
// }

// export interface Statements {
//     id: number;
//     sequence: number;
//     speaker: string;
//     content: string;
// }

// export interface Task {
//     id: number;
//     name: string;
//     documents: Document[];
//     discussions: Discussion[];
//     status: ProjectStatus;
// }

// export interface DevelopmentStage {
//     id: number;
//     type: DevelopmentStageType;
//     name: string;
//     documents: Document[];
//     discussions: Discussion[];
//     tasks: Task[];
//     status: ProjectStatus;
// }

// export interface Project {
//     id: number;
//     name: string;
//     stages: DevelopmentStage[];
//     status: ProjectStatus;
// }

// // Relationship Model
// class _RelationshipModel extends Model { }
// _RelationshipModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     type: DataTypes.STRING,
//     fmId: DataTypes.NUMBER,
//     toId: DataTypes.NUMBER,
// }, { sequelize, modelName: 'relationships' });

// export class RelationshipModelModel extends _RelationshipModel { }

// // ProjectDocument Model
// class _ProjectDocumentModel extends Model { }
// _ProjectDocumentModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     projectId: DataTypes.NUMBER,
//     documentId: DataTypes.NUMBER,
// }, { sequelize, modelName: 'project_documents' });

// export class ProjectDocumentModel extends _ProjectDocumentModel { }

// // Document Model
// class _DocumentModel extends Model { }
// _DocumentModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     type: DataTypes.STRING,
//     subType: DataTypes.STRING,
//     title: DataTypes.STRING,
//     content: DataTypes.TEXT,
//     status: DataTypes.STRING,
// }, { sequelize, modelName: 'documents' });

// export class DocumentModel extends _DocumentModel { }

// // Discussion Model
// class _DiscussionModel extends Model { }
// _DiscussionModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     topic: DataTypes.STRING,
//     // Statementsは別のテーブルとして関連付けるか、JSONとして保存する
// }, { sequelize, modelName: 'discussions' });

// export class DiscussionModel extends _DiscussionModel { }

// // Discussion Participant Model
// class _DiscussionParticipantModel extends Model { }
// _DiscussionParticipantModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     discussionId: DataTypes.NUMBER,
//     userId: DataTypes.NUMBER,
//     // DiscussionとUserを関連付ける
// }, { sequelize, modelName: 'discussionParticipants' });

// export class DiscussionParticipantModel extends _DiscussionParticipantModel { }

// // Statement Model
// class _StatementModel extends Model { }
// _StatementModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     sequence: DataTypes.NUMBER,
//     speaker: DataTypes.STRING,
//     content: DataTypes.TEXT,
// }, { sequelize, modelName: 'statements' });

// export class StatementModel extends _StatementModel { }

// // Task Model
// class _TaskModel extends Model { }
// _TaskModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     name: DataTypes.STRING,
//     status: DataTypes.STRING,
//     // documents, discussionsは関連付けて設定する
// }, { sequelize, modelName: 'tasks' });

// export class TaskModel extends _TaskModel { }

// // DevelopmentStage Model
// class _DevelopmentStageModel extends Model { }
// _DevelopmentStageModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     type: DataTypes.STRING,
//     name: DataTypes.STRING,
//     status: DataTypes.STRING,
//     // documents, discussions, tasksは関連付けて設定する
// }, { sequelize, modelName: 'developmentStages' });

// export class DevelopmentStageModel extends _DevelopmentStageModel { }

// // Project Model
// class _ProjectModel extends Model { }
// _ProjectModel.init({
//     id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
//     name: DataTypes.STRING,
//     status: DataTypes.STRING,
//     // stagesは関連付けて設定する
// }, { sequelize, modelName: 'projects' });

// export class ProjectModel extends _ProjectModel { }


// // アソシエーションの設定
// ProjectModel.belongsToMany(TaskModel, { through: 'project_task' });
// TaskModel.belongsToMany(ProjectModel, { through: 'project_task' });

// ProjectModel.belongsToMany(DocumentModel, { through: 'project_document' });
// DocumentModel.belongsToMany(ProjectModel, { through: 'project_document' });

// ProjectModel.belongsToMany(DiscussionModel, { through: 'project_discussion' });
// DiscussionModel.belongsToMany(ProjectModel, { through: 'project_discussion' });

// TaskModel.belongsToMany(DocumentModel, { through: 'task_document' });
// DocumentModel.belongsToMany(TaskModel, { through: 'task_document' });

// DevelopmentStageModel.belongsToMany(TaskModel, { through: 'stage_task' });
// TaskModel.belongsToMany(DevelopmentStageModel, { through: 'stage_task' });

// DevelopmentStageModel.belongsToMany(DocumentModel, { through: 'stage_document' });
// DocumentModel.belongsToMany(DevelopmentStageModel, { through: 'stage_document' });




// // データベースにテーブルがなければ作成
// sequelize.sync().then(() => {
//     console.log('テーブルが作成されました。');
// }).catch(error => {
//     console.error('テーブル作成中にエラーが発生しました:', error);
// });



