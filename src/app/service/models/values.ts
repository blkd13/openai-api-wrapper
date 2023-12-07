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
    DeploymentPlan = 'Deployment Plan',
    DesignSpecifications = 'Design Specifications',
    ImplementationGuide = 'Implementation Guide',
    MaintenanceLog = 'Maintenance Log',
    MeetingNotes = 'Meeting Notes',
    ProjectPlan = 'Project Plan',
    Requirements = 'Requirements',
    TestCases = 'Test Cases',

    // 要件定義関連
    FeatureRequirements = 'Feature Requirements',    // Summary、Detail

    // 基本設計工程
    ScreenDesign = 'Screen Design',       // Summary、Detail
    ScreenComponentDesign = 'Screen Component Design',
    APIDesign = 'API Design',             // Summary、Detail
    DatabaseDesign = 'Database Design',   // Summary、Detail
    DatabaseTableDesign = 'Database Table Design',
    DatabaseSequenceDesign = 'Database Table Design',
    DatabaseIndexDesign = 'Database Table Design',
}

export enum DocumentSubType {
    // 要件定義関連
    BusinessRequirements = 'Business Requirements',
    SystemRequirements = 'System Requirements',
    UserStories = 'User Stories',

    FeatureRequirements = 'Feature Requirements',
    FeatureListSummary = 'Feature ListSummary',
    FeatureListDetail = 'Feature List Detail',

    // 設計関連
    HighLevelDesign = 'High Level Design', // 日本語で言うところの「基本設計」
    DetailedDesign = 'Detailed Design',    // 日本語で言うところの「詳細設計」
    DatabaseDesign = 'Database Design',    // 日本語で言うところの「DB設計」
    InterfaceDesign = 'Interface Design',  // 日本語で言うところの「画面設計」

    // リストもの
    SummaryList = 'Summary List',
    DetailList = 'Detail List',

    LowLevelDesign = 'Low Level Design',   // 日本語で言うところの「詳細設計」
    ScreenDesign = 'Screen Design',        // 日本語で言うところの「画面設計」
    ScreenTransitionDiagram = 'Screen Transition Diagram', // 日本語で言うところの「画面遷移図」
    APIDocumentation = 'API Documentation',  // 日本語で言うところの「API設計」

    // 実装関連
    TechnicalSpecifications = 'Technical Specifications',
    DevelopmentGuidelines = 'Development Guidelines',
    SourceCode = 'Source Code',

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
    StakeholderCommunication = 'Stakeholder Communication',

    // その他
    Other = 'Other',
    Memo = 'Memo',
    Notes = 'Notes',
    Log = 'Log',
    History = 'History',
}