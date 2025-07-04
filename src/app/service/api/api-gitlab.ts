import { Request, Response } from 'express';
import { body, param } from "express-validator";
import { OAuthUserRequest } from "../models/info.js";
import { ds } from '../db.js';
import { ExtApiClient, getExtApiClient } from '../controllers/auth.js';
import { GitLabProject } from './gitlab-api-types.js';
import { ProjectEntity, TeamMemberEntity } from '../entity/project-models.entity.js';
import { FileGroupType, ProjectVisibility, } from '../models/values.js';
import { GitProjectCommitEntity } from '../entity/api-git.entity.js';
import { copyFromFirst, gitFetchCommitId } from './git-core.js';
import { getAxios } from '../../common/http-client.js';

export const fetchCommit = [
    param('providerName').isString().notEmpty(),
    param('gitlabProjectId').isNumeric().notEmpty(),
    param('refType').isIn(['branches', 'tags', 'commits']).optional(),
    // param('refId').isString().optional(),
    body('projectId').isString().notEmpty(),
    async (_req: Request, res: Response) => {
        try {
            const req = _req as OAuthUserRequest;
            const { providerName, gitlabProjectId, refType } = req.params as { providerName: string, gitlabProjectId: string, refType?: 'branches' | 'tags' | 'commits' };
            const { projectId } = req.body as { projectId: string };
            const provider = `gitlab-${providerName}`;

            const refId = req.params[0] as string | undefined;

            const project = await ds.getRepository(ProjectEntity).findOne({ where: { orgKey: req.info.user.orgKey, id: projectId } });
            if (!project) {
                res.status(404).json({ message: '指定されたプロジェクトが見つかりません' });
                return;
            }

            const teamMember = await ds.getRepository(TeamMemberEntity).findOne({
                where: { orgKey: req.info.user.orgKey, userId: req.info.user.id, teamId: project.teamId }
            });

            if (project.visibility !== ProjectVisibility.Public && project.visibility !== ProjectVisibility.Login && !teamMember) {
                res.status(403).json({ message: 'このプロジェクトにファイルをアップロードする権限がありません' });
                return;
            }

            const e = {} as ExtApiClient;
            try {
                Object.assign(e, await getExtApiClient(req.info.user.orgKey, provider));
            } catch (error) {
                res.status(401).json({ error: `${provider}は認証されていません。` });
                return;
            }
            const _axios = await getAxios(e.uriBase);

            // provider から GitLab の baseUrl などを取り出す想定
            // 例: readOAuth2Env(provider) の結果を使う
            const baseUrl = e.uriBase;
            const accessToken = req.info.oAuth.accessToken;
            const username = 'oauth2';

            // プロジェクト情報取得 (参照権限チェックのため）
            const gitlabProjectRes = await _axios.get<GitLabProject>(`${baseUrl}/api/v4/projects/${gitlabProjectId}`, { headers: { Authorization: `Bearer ${accessToken}`, }, });
            const gitlabProject = gitlabProjectRes.data;

            console.log(`${refType}:${refId}`);
            let commitId: string;
            switch (refType) {
                case 'branches':
                    const branches = await _axios.get<GitlabBranch>(`${baseUrl}/api/v4/projects/${gitlabProjectId}/repository/branches/${encodeURIComponent(refId || '')}`, { headers: { Authorization: `Bearer ${accessToken}`, }, });
                    commitId = branches.data.commit.id || gitlabProject.default_branch;
                    break;
                case 'tags':
                    const tags = await _axios.get<GitlabTag>(`${baseUrl}/api/v4/projects/${gitlabProjectId}/repository/tags/${encodeURIComponent(refId || '')}`, { headers: { Authorization: `Bearer ${accessToken}`, }, });
                    commitId = tags.data.commit.id || gitlabProject.default_branch;
                    break;
                case 'commits':
                    const commits = await _axios.get<GitlabCommit>(`${baseUrl}/api/v4/projects/${gitlabProjectId}/repository/commits/${refId}`, { headers: { Authorization: `Bearer ${accessToken}`, }, });
                    commitId = commits.data.id || gitlabProject.default_branch;
                    break;
                default:
                    const _branches = await _axios.get<GitlabBranch>(`${baseUrl}/api/v4/projects/${gitlabProjectId}/repository/branches/${encodeURIComponent(gitlabProject.default_branch)}`, { headers: { Authorization: `Bearer ${accessToken}`, }, });
                    commitId = _branches.data.commit.id || gitlabProject.default_branch;
                    break;
            };

            let gitProjectCommit = await ds.getRepository(GitProjectCommitEntity).findOne({
                where: { orgKey: req.info.user.orgKey, provider, gitProjectId: Number(gitlabProjectId), commitId }
            })

            let fileGroup;

            if (gitProjectCommit) {
                // 既に同じコミットをダウンロード済みの場合
                fileGroup = await copyFromFirst(gitProjectCommit.fileGroupId, project, req.info.user.orgKey, req.info.user.id, req.info.ip);
            } else {
                const object = await gitFetchCommitId(req.info.user.orgKey, req.info.user.id, req.info.ip, projectId, FileGroupType.GITLAB, gitlabProject.name, provider, { provider, projectId: gitlabProjectId, refType, refId, commitId }, Number(gitlabProjectId), e.uriBase, gitlabProject.http_url_to_repo, gitlabProject.path_with_namespace, username, accessToken, commitId, req.info.user);
                gitProjectCommit = object.gitProjectCommit;
                fileGroup = object.fileGroup;
            }
            // console.log('res.json:fileGroup:', fileGroup);
            res.json({ gitProjectCommit, fileGroup });

        } catch (err) {
            console.error(err);
            if (err instanceof Error) {
                try {
                    const obj = JSON.parse(err.message);
                    res.status(obj.status || 500).json(obj);
                } catch (e) {
                    res.status(500).json({ error: 'Failed to download all files' });
                }
            } else {
                res.status(500).json({ error: 'Failed to download all files' });
            }
        }
    },
];

export interface GitlabBranch {
    name: string;
    commit: {
        id: string;
        short_id: string;
        created_at: string;
        title: string;
        message: string;
        author_name: string;
        author_email: string;
    };
    merged: boolean;
    protected: boolean;
    developers_can_push: boolean;
    developers_can_merge: boolean;
}

export interface GitlabTag {
    name: string;
    message: string;
    target: string;
    commit: {
        id: string;
        short_id: string;
        title: string;
        created_at: string;
        parent_ids: string[];
    };
    release?: {
        tag_name: string;
        description: string;
    };
}

export interface GitlabCommit {
    id: string;
    short_id: string;
    created_at: string;
    title: string;
    message: string;
    author_name: string;
    author_email: string;
    committer_name: string;
    committer_email: string;
    parent_ids: string[];
}

// 全体を取得するデータ型
export interface GitLabData {
    branches: GitlabBranch[];
    tags: GitlabTag[];
    commits: GitlabCommit[];
}
