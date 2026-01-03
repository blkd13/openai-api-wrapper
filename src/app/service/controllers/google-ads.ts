// lib/googleAds.ts
import { OAuth2Client } from 'google-auth-library';

const {
    GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    GOOGLE_ADS_CUSTOMER_ID,
    GOOGLE_ADS_OAUTH_CLIENT_ID,
    GOOGLE_ADS_OAUTH_CLIENT_SECRET,
    GOOGLE_ADS_OAUTH_REFRESH_TOKEN,
    GOOGLE_ADS_CURRENCY = 'USD',
} = process.env;

const ADS_BASE = 'https://googleads.googleapis.com/v16';

async function getAccessToken(): Promise<string> {
    const oauth2 = new OAuth2Client({
        clientId: GOOGLE_ADS_OAUTH_CLIENT_ID!,
        clientSecret: GOOGLE_ADS_OAUTH_CLIENT_SECRET!,
    });
    oauth2.setCredentials({ refresh_token: GOOGLE_ADS_OAUTH_REFRESH_TOKEN! });
    const { token } = await oauth2.getAccessToken();
    if (!token) throw new Error('Failed to obtain Google Ads access token');
    return token;
}

/**
 * Google Ads に Click Conversion をアップロード
 * @param gclid クリックID（URLの gclid）
 * @param occurredAt JS Date（サインアップ完了時刻）
 * @param value 金額（無料なら 0）
 */
export async function uploadClickConversion(gclid: string, GOOGLE_ADS_CONVERSION_ACTION: string, occurredAt: Date, value = 0) {
    if (!gclid) throw new Error('Missing gclid');
    if (!GOOGLE_ADS_CONVERSION_ACTION) throw new Error('Missing GOOGLE_ADS_CONVERSION_ACTION');
    if (!GOOGLE_ADS_DEVELOPER_TOKEN) throw new Error('Missing GOOGLE_ADS_DEVELOPER_TOKEN');
    if (!GOOGLE_ADS_LOGIN_CUSTOMER_ID) throw new Error('Missing GOOGLE_ADS_LOGIN_CUSTOMER_ID');
    const accessToken = await getAccessToken();

    // Google Ads の要求形式: "YYYY-MM-DD HH:MM:SS+00:00" （UTC）
    const conversionDateTime = occurredAt
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '+00:00')
        .replace(/\.\d{3}/, ''); // ミリ秒を落とす

    const url = `${ADS_BASE}/customers/${GOOGLE_ADS_CUSTOMER_ID}:uploadClickConversions`;

    const body = {
        customer_id: GOOGLE_ADS_CUSTOMER_ID, // 任意
        partial_failure: false,
        validate_only: false,
        conversions: [
            {
                gclid,
                conversion_action: GOOGLE_ADS_CONVERSION_ACTION,
                conversion_date_time: conversionDateTime,
                currency_code: GOOGLE_ADS_CURRENCY,
                conversion_value: value,
            },
        ],
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN!,
            'login-customer-id': GOOGLE_ADS_LOGIN_CUSTOMER_ID!, // 管理アカ
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Google Ads upload failed: ${resp.status} ${resp.statusText} — ${text}`);
    }

    return resp.json(); // { partialFailureError?, results: [...] }
}
