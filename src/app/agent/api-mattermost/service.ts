// import axios, { AxiosRequestConfig } from 'axios';
// import { paths } from './mattermohost-openapi-v4.js'; // 生成された型定義ファイルをインポート

// // ユーティリティ型定義
// type ExtractResponse<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
// type ExtractRequest<T> = T extends { post: { content: { 'application/json': infer R } } } ? R : never;

// // エンドポイントごとの型定義
// type GetUsersResponse = ExtractResponse<paths['/api/v4/users']>;
// type CreateUserRequest = ExtractRequest<paths['/api/v4/users']>;
// type CreateUserResponse = ExtractResponse<paths['/api/v4/users']>;

// // API呼び出しの抽象化関数
// async function apiCall<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
//     const response = await axios.get<T>(url, config);
//     return response.data;
// }

// // 特定のAPIエンドポイントに対する関数
// export const fetchUsers = async (): Promise<GetUsersResponse> => {
//     return apiCall<GetUsersResponse>('/api/v4/users');
// };

// export const createUser = async (userData: CreateUserRequest): Promise<CreateUserResponse> => {
//     const response = await axios.post<CreateUserResponse>('/api/v4/users', userData);
//     return response.data;
// };

// // エンドポイントと型のマッピング
// type EndpointMap = {
//     '/users': {
//         'get': GetUsersResponse;
//         'post': CreateUserResponse;
//     }
// };

// // マッピング型を使ったAPI呼び出し関数
// function fetchApi<T1 extends keyof EndpointMap, T2 extends keyof EndpointMap[T1]>(url: T1, method: T2): Promise<EndpointMap[T1][T2]> {
//     return axios.get<EndpointMap[T1][T2]>(url).then(response => response.data);
// }

// // 使用例
// fetchUsers().then(users => {
//     console.log('Fetched Users:', users);
// });

// const newUser: CreateUserRequest = {
//     username: 'new_user',
//     password: 'strongpassword',
//     email: 'new_user@example.com',
// };

// createUser(newUser).then(user => {
//     console.log('Created User:', user);
// });
