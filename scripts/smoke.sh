#!/usr/bin/env bash
# Prueba de humo de los 2 workers (local por defecto).
#   API=http://127.0.0.1:8787 SYNC=http://127.0.0.1:8788 PROVISION_TOKEN=... bash scripts/smoke.sh
set -euo pipefail
API=${API:-http://127.0.0.1:8787}
SYNC=${SYNC:-http://127.0.0.1:8788}
TOKEN_P=${PROVISION_TOKEN:-$(grep -E '^PROVISION_TOKEN=' .dev.vars | cut -d= -f2-)}
STAMP=$(date +%s)
ADMIN="admin+$STAMP@kio-sbs.test"
PASS="KioSbs2026"
fail() { echo "❌ $*"; exit 1; }
ok() { echo "✅ $*"; }

gql() { # url token query variables-json
  curl -s "$1/graphql" -H 'Content-Type: application/json' ${2:+-H "Authorization: Bearer $2"} \
    -d "$(jq -nc --arg q "$3" --argjson v "${4:-{\}}" '{query:$q, variables:$v}')"
}

curl -sf --retry 40 --retry-connrefused --retry-delay 1 "$API/health" >/dev/null || fail "API no responde"
curl -sf --retry 40 --retry-connrefused --retry-delay 1 "$SYNC/health" >/dev/null || fail "SYNC no responde"
ok "health api + sync"

R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/provision" -H 'X-Provision-Token: malo' -H 'Content-Type: application/json' -d '{}')
[ "$R" = 401 ] || fail "provision sin token debería ser 401 ($R)"
R=$(curl -s -X POST "$API/provision" -H "X-Provision-Token: $TOKEN_P" -H 'Content-Type: application/json' \
  -d "{\"company\":{\"name\":\"Panadería Demo $STAMP\",\"nit\":\"900000000-1\"},\"admin\":{\"name\":\"Admin Demo\",\"email\":\"$ADMIN\",\"password\":\"$PASS\"},\"demo\":true}")
echo "$R" | jq -e '.company.id' >/dev/null || fail "provision: $R"
ok "provision empresa + demo ($(echo "$R" | jq .rows) filas)"

R=$(gql "$API" "" 'mutation($e:String!){login(email:$e,password:"mala1234"){token}}' "{\"e\":\"$ADMIN\",\"p\":\"x\"}")
echo "$R" | jq -e '.errors[0].extensions.code=="UNAUTHENTICATED"' >/dev/null || fail "login con clave mala: $R"
R=$(gql "$API" "" 'mutation($e:String!,$p:String!){login(email:$e,password:$p,deviceId:"smoke-device-01"){token me{user{name role} company{name} permissions}}}' "{\"e\":\"$ADMIN\",\"p\":\"$PASS\"}")
T=$(echo "$R" | jq -r '.data.login.token'); [ ${#T} = 64 ] || fail "login: $R"
ok "login admin (token 64 hex)"

R=$(gql "$API" "" '{ me { user { id } } }')
echo "$R" | jq -e '.errors[0].extensions.code=="UNAUTHENTICATED"' >/dev/null || fail "me sin token: $R"
ok "consulta sin token rechazada"

R=$(gql "$API" "$T" '{ products(limit:3){ total items{ name price stock category{ name } } } partners(customers:true){ total items{ name balance availableCredit } } payrollParams{ year smmlv transportAid } }')
echo "$R" | jq -e '.data.products.total==7 and .data.products.items[0].stock==50 and .data.payrollParams.smmlv==1750905' >/dev/null || fail "consultas: $R"
ok "GraphQL productos/clientes/parámetros nómina"

# ---------------------------------------------------------------- sync
R=$(gql "$SYNC" "$T" 'query($d:DeviceInput){ pull(since:0, limit:500, device:$d){ cursor head hasMore changes{ table rows } } }' '{"d":{"id":"smoke-device-01","name":"Smoke","platform":"linux","appVersion":"1.0.0"}}')
CUR=$(echo "$R" | jq '.data.pull.cursor'); [ "$CUR" -gt 0 ] || fail "pull inicial: $R"
PID=$(echo "$R" | jq -r '.data.pull.changes[]|select(.table=="products").rows[0].id')
CID=$(echo "$R" | jq -r '.data.pull.changes[]|select(.table=="partners").rows[]|select(.payment_term_days==30 and .is_customer==1).id')
ok "pull inicial: cursor=$CUR tablas=$(echo "$R" | jq -c '[.data.pull.changes[].table]')"

SALE=$(uuidgen); NOW=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ); TODAY=$(date +%Y-%m-%d)
CH=$(jq -nc --arg s "$SALE" --arg p "$PID" --arg c "$CID" --arg n "$NOW" --arg d "$TODAY" --arg l "$(uuidgen)" --arg m "$(uuidgen)" --arg pay "$(uuidgen)" '{changes:[
 {table:"sales", row:{id:$s, number:"SMK-0001", channel:"pedido", partner_id:$c, date:($d+"T10:00:00"), due_date:"2020-01-01", status:"confirmada", payment_mode:"credito", subtotal:100000, tax_total:19000, total:119000, updated_at:$n}},
 {table:"sale_lines", row:{id:$l, sale_id:$s, product_id:$p, name:"Café americano", qty:2, price:50000, tax_rate:0.19, subtotal:100000, tax:19000, total:119000, updated_at:$n}},
 {table:"stock_moves", row:{id:$m, product_id:$p, qty:-2, kind:"venta", ref_id:$s, date:$d, updated_at:$n}},
 {table:"payments", row:{id:$pay, kind:"abono", sale_id:$s, partner_id:$c, date:$d, method:"transferencia", amount:19000, updated_at:$n}},
 {table:"tabla_falsa", row:{id:"abcdefgh1"}}]}')
R=$(curl -s "$SYNC/graphql" -H 'Content-Type: application/json' -H "Authorization: Bearer $T" \
  -d "$(jq -nc --argjson v "$CH" '{query:"mutation($changes:[ChangeInput!]!){push(changes:$changes){accepted rejected{table reason} head}}", variables:$v}')")
echo "$R" | jq -e '.data.push.accepted==4 and (.data.push.rejected|length)==1' >/dev/null || fail "push: $R"
ok "push 4 aceptados, 1 rechazado (tabla desconocida)"

R=$(gql "$SYNC" "$T" "{ pull(since:$CUR){ cursor changes{ table rows } } }")
echo "$R" | jq -e '[.data.pull.changes[].table]|sort==["payments","sale_lines","sales","stock_moves"]' >/dev/null || fail "pull incremental: $R"
ok "pull incremental trae sólo lo nuevo"

# LWW: una versión más vieja no pisa la nueva
OLD=$(jq -nc --arg s "$SALE" '{changes:[{table:"sales", row:{id:$s, number:"VIEJA", status:"confirmada", payment_mode:"credito", total:1, updated_at:"2001-01-01T00:00:00.000Z"}}]}')
curl -s "$SYNC/graphql" -H 'Content-Type: application/json' -H "Authorization: Bearer $T" \
  -d "$(jq -nc --argjson v "$OLD" '{query:"mutation($changes:[ChangeInput!]!){push(changes:$changes){accepted}}", variables:$v}')" >/dev/null
R=$(gql "$API" "$T" "{ sale(id:\"$SALE\"){ number total paid balance partner{ name balance overdue } lines{ name qty } } dashboard{ kpis{ key value } aging{ bucket amount } } }")
echo "$R" | jq -e '.data.sale.number=="SMK-0001" and .data.sale.balance==100000 and .data.sale.partner.overdue==100000' >/dev/null || fail "LWW/cartera: $R"
ok "LWW respeta la versión más reciente; cartera vencida = 100.000"
echo "$R" | jq -c '.data.dashboard.kpis'

# ---------------------------------------------------------------- roles
CAJ="cajero+$STAMP@kio-sbs.test"
R=$(gql "$API" "$T" 'mutation($i:UserInput!){createUser(input:$i){id role}}' "{\"i\":{\"name\":\"Caja 1\",\"email\":\"$CAJ\",\"password\":\"$PASS\",\"role\":\"cajero\"}}")
echo "$R" | jq -e '.data.createUser.role=="cajero"' >/dev/null || fail "createUser: $R"
TC=$(gql "$API" "" 'mutation($e:String!,$p:String!){login(email:$e,password:$p){token}}' "{\"e\":\"$CAJ\",\"p\":\"$PASS\"}" | jq -r .data.login.token)
R=$(gql "$API" "$TC" '{ employees { name } }')
echo "$R" | jq -e '.errors[0].extensions.code=="FORBIDDEN"' >/dev/null || fail "cajero ve empleados: $R"
R=$(gql "$SYNC" "$TC" '{ pull(since:0){ changes{ table } } }')
echo "$R" | jq -e '[.data.pull.changes[].table]|index("employees")==null' >/dev/null || fail "cajero recibe empleados por sync: $R"
EXP=$(jq -nc --arg e "$(uuidgen)" '{changes:[{table:"expenses", row:{id:$e, concept:"Taxi", amount:15000, status:"aprobada"}},{table:"products", row:{id:"abcdefgh12", name:"hack"}}]}')
R=$(curl -s "$SYNC/graphql" -H 'Content-Type: application/json' -H "Authorization: Bearer $TC" \
  -d "$(jq -nc --argjson v "$EXP" '{query:"mutation($changes:[ChangeInput!]!){push(changes:$changes){accepted rejected{table reason}}}", variables:$v}')")
echo "$R" | jq -e '.data.push.accepted==0 and (.data.push.rejected|length)==2' >/dev/null || fail "cajero aprueba gasto / edita productos: $R"
ok "roles: cajero sin nómina, no aprueba gastos ni edita productos"

R=$(gql "$API" "$T" '{ a:me{user{id}} b:partners{items{sales{partner{sales{partner{sales{partner{sales{id}}}}}}}}} }')
echo "$R" | jq -e '.errors[0].message|test("profunda")' >/dev/null || fail "límite de profundidad: $R"
ok "consultas demasiado profundas rechazadas"

# ---------------------------------------------------------------- regresiones (hallazgos QA Alex/Steven)
pushq() { curl -s "$SYNC/graphql" -H 'Content-Type: application/json' -H "Authorization: Bearer $1" \
  -d "$(jq -nc --argjson v "$2" '{query:"mutation($changes:[ChangeInput!]!){push(changes:$changes){accepted rejected{table reason}}}", variables:$v}')"; }
NOW2=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)

R=$(gql "$API" "$T" '{ partners(withBalance:true){ total items{ name balance } } }')
echo "$R" | jq -e '.data.partners.total==1 and .data.partners.items[0].balance==100000' >/dev/null || fail "withBalance (HAVING): $R"
ok "partners(withBalance) usa la suma del saldo"

VEN="vend+$STAMP@kio-sbs.test"
gql "$API" "$T" 'mutation($i:UserInput!){createUser(input:$i){id}}' "{\"i\":{\"name\":\"Vendedor\",\"email\":\"$VEN\",\"password\":\"$PASS\",\"role\":\"vendedor\"}}" >/dev/null
TV=$(gql "$API" "" 'mutation($e:String!,$p:String!){login(email:$e,password:$p){token}}' "{\"e\":\"$VEN\",\"p\":\"$PASS\"}" | jq -r .data.login.token)
pushq "$TV" "$(jq -nc --arg c "$CID" --arg n "$NOW2" '{changes:[{table:"partners", row:{id:$c, name:"Cliente renombrado", credit_limit:999999999, blocked:0, updated_at:$n}}]}')" >/dev/null
R=$(gql "$API" "$T" "{ partner(id:\"$CID\"){ name creditLimit } }")
echo "$R" | jq -e '.data.partner.creditLimit==5000000 and .data.partner.name=="Cliente renombrado"' >/dev/null || fail "vendedor cambia cupo: $R"
ok "vendedor edita el contacto pero no el cupo de crédito"

R=$(gql "$API" "$TV" '{ users { email } }'); echo "$R" | jq -e '.errors[0].extensions.code=="FORBIDDEN"' >/dev/null || fail "vendedor lista usuarios: $R"
R=$(gql "$API" "$TV" "{ sale(id:\"$SALE\"){ seller { name email } } partner(id:\"$CID\"){ name } }")
echo "$R" | jq -e '.data.sale.seller==null or .data.sale.seller.email==null' >/dev/null || fail "fuga de email: $R"
ok "datos de otros usuarios no se exponen a operadores"

CUR2=$(gql "$SYNC" "$TC" '{ status { head } }' | jq .data.status.head)
pushq "$TC" "$(jq -nc --arg s "$SALE" --arg n "$NOW2" '{changes:[{table:"sales", row:{id:$s, total:1, deleted:1, updated_at:$n}}]}')" >/dev/null
R=$(gql "$API" "$T" "{ sale(id:\"$SALE\"){ total } }")
echo "$R" | jq -e '.data.sale.total==119000' >/dev/null || fail "cajero altera venta confirmada: $R"
R=$(gql "$SYNC" "$TC" "{ pull(since:$CUR2){ changes{ table rows } } }")
echo "$R" | jq -e '[.data.pull.changes[]|select(.table=="sales").rows[]|select(.total==119000 and .deleted==0)]|length==1' >/dev/null || fail "el perdedor no recibe la versión ganadora: $R"
ok "venta confirmada bloqueada para cajero y el equipo recibe la versión ganadora"

R=$(curl -s "$SYNC/graphql" -H 'Content-Type: application/json' -H "Authorization: Bearer $T" \
  -d '{"query":"mutation{ a:push(changes:[]){accepted} b:push(changes:[]){accepted} }"}')
echo "$R" | jq -e '.errors[0].message|test("un push")' >/dev/null || fail "push con alias: $R"
R=$(gql "$API" "$T" 'query{ partners{ items{ ...A } } } fragment A on Partner { sales { partner { sales { partner { ...B } } } } } fragment B on Partner { sales { partner { sales { partner { sales { id } } } } } }')
echo "$R" | jq -e '.errors[0].message|test("profunda")' >/dev/null || fail "bypass profundidad con fragmentos: $R"
R=$(gql "$SYNC" "$T" '{ pull(since:0){ cursor } }')
R=$(curl -s "$SYNC/graphql" -H 'Content-Type: application/json' -H "Authorization: Bearer $T" -d '{"query":"mutation{ push(changes:[{table:\"__proto__\", row:{id:\"abcdefgh12\"}}]){accepted rejected{reason}} }"}')
echo "$R" | jq -e '.data.push.rejected[0].reason=="Tabla desconocida"' >/dev/null || fail "__proto__: $R"
ok "push con alias, fragmentos profundos y __proto__ rechazados"

LIMITED=0
for i in $(seq 1 14); do
  E="$ADMIN$(printf '%*s' $i '')"
  R=$(gql "$API" "" 'mutation($e:String!){login(email:$e,password:"mala1234"){token}}' "$(jq -nc --arg e "$E" '{e:$e}')")
  echo "$R" | jq -e '.errors[0].extensions.code=="RATE_LIMITED"' >/dev/null && LIMITED=$((LIMITED+1))
done
[ $LIMITED -gt 0 ] || fail "rate limit evadido con espacios"
ok "rate limit de login no se evade con espacios ($LIMITED de 14 limitados)"
echo "🎉 Smoke OK"
