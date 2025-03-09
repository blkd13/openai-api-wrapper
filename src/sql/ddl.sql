-- DROP VIEW predict_history_view;
CREATE
OR REPLACE VIEW predict_history_view AS
SELECT
    p0.name,
    COALESCE(p2.created_by, p1.created_by) AS created_by,
    COALESCE(p2.created_at, p1.created_at) AS created_at,
    COALESCE(p2.created_ip, p1.created_ip) AS created_ip,
    p1.provider,
    p1.model,
    p1.take,
    p1.req_token,
    p1.res_token,
    p1.cost,
    p1.status,
    p1.message,
    p1.id,
    COALESCE(p2.updated_by, p1.updated_by) AS updated_by,
    COALESCE(p2.updated_at, p1.updated_at) AS updated_at,
    COALESCE(p2.updated_ip, p1.updated_ip) AS updated_ip,
    p1.label,
    p1.idempotency_key,
    p1.args_hash,
    p2.connection_id,
    p2.stream_id,
    p2.message_id
FROM
    (
        predict_history_entity p1
        LEFT JOIN user_entity p0 
        ON label LIKE 'chat-'||p0.id::text||'%' 
        LEFT JOIN predict_history_wrapper_entity p2 USING (label, model, provider)
    )
WHERE
    (
        p1.status = ANY (
            ARRAY ['fine'::predict_history_entity_status_enum, 'error'::predict_history_entity_status_enum]
        )
    )
ORDER BY
    updated_at DESC;
;