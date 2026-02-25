export interface GineeConfig {
    baseUrl: string;
    accessKey: string;
    secretKey: string;
    shopId: string;
}

export interface GineeResponse<T = any> {
    code: string;
    msg: string;
    data: T;
    requestId: string;
}