export interface InterviewConfig {
    mode: 'general' | 'repository';
    repositoryId?: string;
    domain?: 'dsa' | 'development' | 'core' | 'data' | 'ai';
    language?: string;
    technologies?: string[];
    difficulty: 'easy' | 'medium' | 'hard' | 'adaptive';
    focusTopics?: string[];
    questionCount?: number;
    followUpsEnabled: boolean;
}

export interface InterviewState {
    currentTopic: string;
    topicsCovered: string[];
    topicsToExplore: string[];
    difficulty: 'easy' | 'medium' | 'hard' | 'adaptive';
    questionCount: number;
    depth: 'repository' | 'architecture' | 'component' | 'file' | 'implementation';
    lastQuestionType: 'initial' | 'follow_up' | 'depth' | 'topic_transition';
    assessment?: InterviewFinalAssessment;
}

export interface InterviewFinalAssessment {
    overallAssessment: string;
    strengths: string[];
    weaknesses: string[];
    score: number;
}

export interface InterviewTurnEvaluation {
    score: number;
    answerQuality: 'poor' | 'weak' | 'adequate' | 'strong' | 'excellent';
    technicalAccuracy: number;
    depthOfUnderstanding: number;
    strengths: string[];
    weaknesses: string[];
    missingConcepts: string[];
    topic: string;
    nextAction: 'deepen' | 'clarify' | 'move_topic';
    nextDifficulty: 'easy' | 'medium' | 'hard';
    nextQuestionType: 'follow_up' | 'depth' | 'topic_transition';
    nextQuestion: string;
    correction: {
        needed: boolean;
        explanation: string;
        keyPoints: string[];
    };
}
