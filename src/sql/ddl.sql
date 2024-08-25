-- DROP VIEW predict_history_view;
CREATE
OR REPLACE VIEW predict_history_view AS
SELECT
    p1.id,
    p1.label,
    p1.model,
    p1.provider,
    p1.idempotency_key,
    p1.args_hash,
    p1.take,
    p1.req_token,
    p1.res_token,
    p1.cost,
    p1.status,
    COALESCE(p2.created_by, p1.created_by) AS created_by,
    COALESCE(p2.created_at, p1.created_at) AS created_at,
    COALESCE(p2.updated_by, p1.updated_by) AS updated_by,
    COALESCE(p2.updated_at, p1.updated_at) AS updated_at,
    p1.message,
    p2.connection_id,
    p2.stream_id,
    p2.message_id
FROM
    (
        predict_history_entity p1
        LEFT JOIN predict_history_wrapper_entity p2 USING (label, model, provider)
    )
WHERE
    (
        p1.status = ANY (
            ARRAY ['fine'::predict_history_entity_status_enum, 'error'::predict_history_entity_status_enum]
        )
    )
ORDER BY
    created_at DESC;
;