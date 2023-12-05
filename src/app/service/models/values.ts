export enum ProjectStatus {
    NotStarted = 'NotStarted',         // 未開始
    InProgress = 'InProgress',         // 進行中
    OnHold = 'OnHold',                 // 中断
    Completed = 'Completed',           // 完了
    Cancelled = 'Cancelled',           // 中止
    PendingReview = 'PendingReview',   // レビュー待ち
    Reviewed = 'Reviewed',             // レビュー済み
    Approved = 'Approved',             // 承認済み
    Rejected = 'Rejected',             // 拒否
    Pending = 'Pending',               // 保留
    Incomplete = 'Incomplete',         // 未完了
    Deleted = 'Deleted',               // 削除済み
    Hidden = 'Hidden',                 // 非表示
}

export enum DevelopmentStageType {
    RequirementAnalysis = 'Requirement Analysis',
    Design = 'Design',
    Implementation = 'Implementation',
    Testing = 'Testing',
    Deployment = 'Deployment',
    Maintenance = 'Maintenance',
    ProjectManagement = 'Project Management'
}

export enum PermissionLevel {
    Owner = 'Owner',
    Admin = 'Admin',
    Editor = 'Editor',
    Viewer = 'Viewer'
}

export enum NotificationType {
    Email = 'Email',
    Slack = 'Slack',
    Webhook = 'Webhook'
}

export enum DocumentType {
    Requirements = 'Requirements',
    DesignSpecifications = 'Design Specifications',
    ImplementationGuide = 'Implementation Guide',
    TestCases = 'Test Cases',
    DeploymentPlan = 'Deployment Plan',
    MaintenanceLog = 'Maintenance Log',
    ProjectPlan = 'Project Plan',
    MeetingNotes = 'Meeting Notes'
}
export enum DocumentSubType {
    // 要件定義関連
    BusinessRequirements = 'Business Requirements',
    SystemRequirements = 'System Requirements',
    UserStories = 'User Stories',

    // 設計関連
    HighLevelDesign = 'High Level Design', // 日本語で言うところの「基本設計」
    DetailedDesign = 'Detailed Design',    // 日本語で言うところの「詳細設計」
    DatabaseDesign = 'Database Design',    // 日本語で言うところの「DB設計」
    InterfaceDesign = 'Interface Design',  // 日本語で言うところの「画面設計」

    // 実装関連
    TechnicalSpecifications = 'Technical Specifications',
    DevelopmentGuidelines = 'Development Guidelines',
    SourceCode = 'Source Code',
    APIDocumentation = 'APIドキュメント',   // 日本語で言うところの「API設計」

    // テスト関連
    TestPlan = 'Test Plan',
    TestCase = 'Test Case',
    TestReport = 'Test Report',

    // デプロイメント関連
    DeploymentStrategy = 'Deployment Strategy',
    ReleaseNotes = 'Release Notes',
    InstallationGuide = 'Installation Guide',

    // メンテナンス関連
    MaintenanceManual = 'Maintenance Manual',
    ChangeLog = 'Change Log',

    // プロジェクト管理関連
    ProjectCharter = 'Project Charter',
    ProjectSchedule = 'Project Schedule',
    RiskAssessment = 'Risk Assessment',

    // 会議とコミュニケーション関連
    MeetingAgenda = 'Meeting Agenda',
    MeetingMinutes = 'Meeting Minutes',
    StakeholderCommunication = 'Stakeholder Communication'
}
