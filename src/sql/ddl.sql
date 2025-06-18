-- 重複しないように作り直した VIEW
--   DROP VIEW predict_history_view;
CREATE OR REPLACE VIEW predict_history_view AS
WITH p1_ranked AS (
    SELECT
        p1.*,
        ROW_NUMBER() OVER (
            PARTITION BY label, model, provider
            ORDER BY updated_at DESC, id
        ) AS rn
    FROM predict_history_entity p1
    WHERE status IN ('fine', 'error')
),
p2_ranked AS (
    SELECT
        p2.*,
        ROW_NUMBER() OVER (
            PARTITION BY label, model, provider
            ORDER BY updated_at DESC, connection_id
        ) AS rn
    FROM predict_history_wrapper_entity p2
)
SELECT
    COALESCE(u.name, u2.name) AS user_name,
    COALESCE(p2.created_by,  p1.created_by)  AS created_by,
    COALESCE(p2.created_at,  p1.created_at)  AS created_at,
    COALESCE(p2.created_ip,  p1.created_ip)  AS created_ip,
    p1.provider,
    p1.model,
    p1.take,
    p1.req_token,
    p1.res_token,
    p1.cost,
    p1.status,
    p1.message,
    p1.id,
    COALESCE(p2.updated_by,  p1.updated_by)  AS updated_by,
    COALESCE(p2.updated_at,  p1.updated_at)  AS updated_at,
    COALESCE(p2.updated_ip,  p1.updated_ip)  AS updated_ip,
    p1.label,
    p1.idempotency_key,
    p1.args_hash,
    p2.connection_id,
    p2.stream_id,
    p2.message_id,
    COALESCE(u.org_key, u2.org_key, p1.org_key) AS org_key,
    COALESCE(u.id, u2.id) AS user_id
FROM
    p1_ranked p1
    LEFT JOIN p2_ranked p2
           ON  p1.label     = p2.label
           AND p1.model     = p2.model
           AND p1.provider  = p2.provider
           AND p1.rn        = p2.rn          -- ★ 同じ順位同士でペアリング
    LEFT JOIN user_entity u
           ON  p1.label LIKE 'chat-' || u.id::text || '%'
    LEFT JOIN user_entity u2
           ON  p1.created_by = u2.id::text -- 本当はuuid比較したいけど、batchと書いてあるモノと混在しているせいで出来ない。。。これのせいで遅い。
ORDER BY
    COALESCE(p2.updated_at, p1.updated_at) DESC;
