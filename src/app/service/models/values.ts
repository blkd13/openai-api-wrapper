
export enum PredictHistoryStatus {
    Start = 'start',
    Enque = 'enque',
    Fine = 'fine',
    Error = 'error',
    Wait = 'wait',
}

export enum ProjectVisibility {
    Default = 'Default', // Defaultはユーザーの個人プロジェクト
    Public = 'Public', // 公開プロジェクト（ログイン不要）
    Team = 'Team', // チームプロジェクト
    Login = 'Login', // ログインユーザーのみ
}

export enum TeamType {
    Alone = 'Alone', // 個人用（一人一個）
    Team = 'Team', // チーム用
}

export enum ThreadGroupVisibility {
    Public = 'Public', // 公開スレッド（ログイン不要）
    Team = 'Team', // チーム内のみ（デフォルト）
    Login = 'Login', // ログインユーザーのみ
    Temporary = 'Temporary', // 一時的なスレッド（デフォルト）
}

export enum ThreadGroupType {
    Normal = 'Normal', // 通常スレッド
    Default = 'Default', // デフォルト設定用（各ユーザー1個しか作らない）
    Template = 'Template', // テンプレートスレッド
    // Announcement = 'Announcement', // お知らせスレッド
    // Temporary = 'Temporary', // 一時的なスレッド
}

export enum MessageGroupType {
    Single = 'Single',
    Parallel = 'Parallel',
    Regenerated = 'Regenerated',
}
export enum MessageClusterType {
    Single = 'Single',
    Parallel = 'Parallel',
    Serial = 'Serial',
    Regenerated = 'Regenerated',
}

export enum ContentPartType {
    TEXT = 'text',
    ERROR = 'error',
    BASE64 = 'base64', // 軽量コンテンツをロードするときに使う、メッセージオブジェクトの配下にくっつけてやるパターン。最初の一回はBase64で登録して、使うときはfileになっている感じ。
    URL = 'url', // インターネットのリンク。基本使わないつもり。
    STORE = 'store', // GCPのStorageに登録されているもの。gs://
    FILE = 'file', // サーバー側にファイルとして保存済みのもの // fileになっているものは登録済みなので、登録処理の時は無視する。
    TOOL = 'tool', // function_call
    TOOL_CALL = 'tool_call', // function_call
    TOOL_RESULT = 'tool_result', // function_call
    META = 'meta', // メタ情報。groundingの結果など。
}

export enum ContentPartStatus {
    Normal = 'Normal', // 普通
    Deleted = 'Deleted', // 削除済み
}

export enum FileGroupType {
    UPLOAD = 'upload', // アップロードの単位
    MERGED = 'merged', // 色々くっつけて自作するやつ
    GIT = 'git', // git
    GITLAB = 'gitlab', // gitlab
    GITEA = 'gitea', // gitea
    BOX = 'box', // box
}

export enum TeamMemberRoleType {
    Maintainer = 'Maintainer', // メンテナ
    Owner = 'Owner', // オーナー
    Admin = 'Admin', // 管理者（オーナーに統合したので今は使わない）
    Member = 'Member', // メンバー（スレッドの作成、編集、削除ができる）
    Viewer = 'Viewer', // 閲覧者（スレッドの閲覧のみ）
    Guest = 'Guest', // ゲスト（スレッドの閲覧のみ）
}

export enum TeamStatus {
    Normal = 'Normal', // 普通
    Deleted = 'Deleted', // 削除済み
}

export enum ThreadStatus {
    Normal = 'Normal', // 普通
    Deleted = 'Deleted', // 削除済み
}

export enum ThreadGroupStatus {
    Normal = 'Normal', // 普通
    Deleted = 'Deleted', // 削除済み
}

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