export interface UserProfile {
    userId: string;
    username: string;
    preferences: string;
    skillLevel: string;
}

export interface SessionInfo {
    sessionId: string;
    startTime: Date;
    endTime: Date;
    content: string;
}

export interface ProjectInfo {
    projectId: string;
    projectName: string;
    description: string;
    status: string;
}

export interface TaskAndProgress {
    taskId: string;
    projectId: string;
    description: string;
    deadline: Date;
    progress: string;
}

export interface ConversationHistory {
    historyId: string;
    sessionId: string;
    dialog: string;
}

export interface ResourceAndDocument {
    resourceId: string;
    projectId: string;
    document: string;
    links: string;
}



// --------------------------------------------------
export interface DomainModel {
    uid: string;
    sid: string;
    id: number
    name: string;
    description: string;
    thumbnailUrl: string;
    type: string;
    planModel: PlanModel[];
}

export interface PlanModel {
    id: number
    name: string;
    description: string;
    features: FeatureDescriptionModel[];
}

export interface FeatureDescriptionModel {
    id: number
    name: string;
    description: string;
    detials: FeatureDetailModel[];
}

export interface FeatureDetailModel {
    id: number
    name: string;
    description: string;
    detials: string[];
}

export interface RequirementsModel {
    id: number
    name: string;
    description: string;
}
