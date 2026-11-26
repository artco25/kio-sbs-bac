export const typeDefs = /* GraphQL */ `
  scalar JSON

  type Company {
    id: ID!
    name: String!
    nit: String
    address: String
    city: String
    phone: String
    email: String
    currency: String!
    receiptFooter: String
    plan: String!
  }

  type User {
    id: ID!
    name: String!
    "Sólo visible para administradores (o el propio usuario)"
    email: String
    role: String!
    active: Boolean!
    employeeId: String
    posTerminal: String
    lastLoginAt: String
    roleId: String
    roleName: String
    platformRole: String
  }

  "Rol personalizado de la empresa: suites a las que entra y permiso por tabla ('r' leer, 'w' escribir)"
  type CustomRole {
    id: ID!
    name: String!
    description: String
    "Rol base: define aprobaciones (admin/contador aprueban) y bloqueos de documentos"
    baseRole: String!
    suites: [String!]!
    permissions: JSON!
    userCount: Int!
  }

  type SuiteInfo {
    key: String!
    label: String!
    tables: [String!]!
  }

  type Me {
    user: User!
    company: Company!
    "Mapa tabla → { read, write } según el rol"
    permissions: JSON!
    "Suites a las que puede ingresar"
    suites: [String!]!
    roleName: String
    platformRole: String
  }

  type AuthPayload {
    token: String!
    expiresAt: String!
    me: Me!
  }

  # ---------------------------------------------------------------- Comercial
  type Partner {
    id: ID!
    name: String
    docType: String
    docNumber: String
    email: String
    phone: String
    address: String
    city: String
    isCustomer: Boolean!
    isSupplier: Boolean!
    creditLimit: Float!
    paymentTermDays: Int!
    blocked: Boolean!
    notes: String
    "Saldo de cartera (ventas a crédito pendientes)"
    balance: Float!
    overdue: Float!
    "null si el cliente no tiene cupo definido"
    availableCredit: Float
    seller: User
    sales(limit: Int): [Sale!]!
  }
  type PartnerPage {
    total: Int!
    items: [Partner!]!
  }

  type Category {
    id: ID!
    name: String
    color: String
    sequence: Int!
    productCount: Int!
  }

  type StockMove {
    id: ID!
    productId: String
    qty: Float!
    kind: String
    refId: String
    date: String
    unitCost: Float!
    notes: String
    createdAt: String
    product: Product
  }

  type Product {
    id: ID!
    name: String
    sku: String
    barcode: String
    unit: String
    price: Float!
    cost: Float!
    taxRate: Float!
    trackStock: Boolean!
    minStock: Float!
    availablePos: Boolean!
    active: Boolean!
    stock: Float!
    category: Category
  }
  type ProductPage {
    total: Int!
    items: [Product!]!
  }

  type Sale {
    id: ID!
    number: String
    channel: String
    date: String
    dueDate: String
    status: String
    paymentMode: String
    posSessionId: String
    kitchenStatus: String
    tableRef: String
    subtotal: Float!
    discountTotal: Float!
    taxTotal: Float!
    total: Float!
    paid: Float!
    balance: Float!
    notes: String
    partner: Partner
    seller: User
    lines: [SaleLine!]!
    payments: [Payment!]!
  }
  type SalePage {
    total: Int!
    amount: Float!
    items: [Sale!]!
  }
  type SaleLine {
    id: ID!
    productId: String
    name: String
    qty: Float!
    price: Float!
    discountPct: Float!
    taxRate: Float!
    subtotal: Float!
    tax: Float!
    total: Float!
  }

  # ---------------------------------------------------------------- POS
  type MethodTotal {
    method: String!
    amount: Float!
    count: Int!
  }
  type PosSession {
    id: ID!
    number: String
    terminal: String
    status: String
    openedAt: String
    closedAt: String
    openingCash: Float!
    expectedCash: Float!
    countedCash: Float!
    difference: Float!
    salesTotal: Float!
    salesCount: Int!
    user: User
    byMethod: [MethodTotal!]!
  }

  # ---------------------------------------------------------------- Financiero
  type Payment {
    id: ID!
    number: String
    kind: String
    date: String
    method: String
    amount: Float!
    reference: String
    saleId: String
    posSessionId: String
    notes: String
    partner: Partner
    sale: Sale
  }
  type Expense {
    id: ID!
    number: String
    date: String
    concept: String
    category: String
    amount: Float!
    tax: Float!
    status: String
    approvedAt: String
    notes: String
    partner: Partner
    requestedBy: User
    approvedBy: User
  }

  # ---------------------------------------------------------------- Personal y nómina
  type Employee {
    id: ID!
    name: String
    docType: String
    docNumber: String
    email: String
    phone: String
    position: String
    department: String
    salary: Float!
    startDate: String
    endDate: String
    contractType: String
    payFrequency: String
    transportAid: Boolean!
    eps: String
    afp: String
    active: Boolean!
    payslips(limit: Int): [Payslip!]!
    leaveRequests: [LeaveRequest!]!
  }
  type Payslip {
    id: ID!
    number: String
    period: String
    dateFrom: String
    dateTo: String
    days: Float!
    basic: Float!
    transport: Float!
    overtime: Float!
    otherEarnings: Float!
    totalEarnings: Float!
    health: Float!
    pension: Float!
    solidarity: Float!
    otherDeductions: Float!
    totalDeductions: Float!
    net: Float!
    employerCost: Float!
    status: String
    detail: JSON
    employee: Employee
  }
  type Novelty {
    id: ID!
    employeeId: String
    period: String
    date: String
    type: String
    quantity: Float!
    amount: Float!
    payslipId: String
    notes: String
    employee: Employee
  }

  type LeaveRequest {
    id: ID!
    type: String
    dateFrom: String
    dateTo: String
    days: Float!
    paid: Boolean!
    status: String
    notes: String
    employee: Employee
  }
  type PayrollParams {
    year: Int!
    smmlv: Float!
    transportAid: Float!
    uvt: Float!
    healthPct: Float!
    pensionPct: Float!
    hoursDivisor: Float!
    sundaySurcharge: Float!
    notes: String
  }

  # ---------------------------------------------------------------- Panel KIO
  type Kpi {
    key: String!
    label: String!
    value: Float!
    previous: Float!
  }
  type MonthPoint {
    month: String!
    sales: Float!
    expenses: Float!
  }
  type AgingBucket {
    bucket: String!
    amount: Float!
    count: Int!
  }
  type TopProduct {
    productId: String
    name: String!
    qty: Float!
    total: Float!
  }
  type DayPoint {
    date: String!
    sales: Float!
    orders: Int!
    expenses: Float!
  }
  "Ventas por día de la semana (0 = domingo) y franja de 2 horas"
  type HeatCell {
    weekday: Int!
    hour: Int!
    amount: Float!
    count: Int!
  }
  type Dashboard {
    from: String!
    to: String!
    kpis: [Kpi!]!
    months: [MonthPoint!]!
    aging: [AgingBucket!]!
    topProducts: [TopProduct!]!
    daily: [DayPoint!]!
    heatmap: [HeatCell!]!
    byMethod: [MethodTotal!]!
    recent: [Sale!]!
  }

  type Device {
    id: ID!
    name: String
    platform: String
    appVersion: String
    lastSyncAt: String
    lastCursor: Int!
    pending: Int!
    user: User
  }

  type PlatformCompany {
    id: ID!
    name: String!
    nit: String
    email: String
    phone: String
    city: String
    plan: String!
    active: Boolean!
    createdAt: String
    usersCount: Int!
    salesCount: Int!
    salesTotal: Float!
    lastActivityAt: String
  }

  type Query {
    me: Me!
    company: Company!
    users: [User!]!
    roles: [CustomRole!]!
    suites: [SuiteInfo!]!
    "true si el auto-registro de empresas está habilitado"
    signupEnabled: Boolean!
    devices: [Device!]!
    platformCompanies: [PlatformCompany!]!
    platformUsers: [User!]!

    partners(search: String, customers: Boolean, suppliers: Boolean, withBalance: Boolean, limit: Int, offset: Int): PartnerPage!
    partner(id: ID!): Partner
    categories: [Category!]!
    stockMoves(productId: ID, kind: String, limit: Int): [StockMove!]!
    products(search: String, categoryId: ID, lowStock: Boolean, limit: Int, offset: Int): ProductPage!
    product(id: ID!): Product
    sales(search: String, channel: String, status: String, partnerId: ID, posSessionId: ID, from: String, to: String, limit: Int, offset: Int): SalePage!
    sale(id: ID!): Sale
    "Ventas a crédito con saldo pendiente (cartera)"
    receivables(partnerId: ID, overdueOnly: Boolean): [Sale!]!

    posSessions(status: String, limit: Int): [PosSession!]!
    posSession(id: ID!): PosSession

    payments(kind: String, from: String, to: String, limit: Int): [Payment!]!
    expenses(status: String, from: String, to: String, limit: Int): [Expense!]!

    employees(active: Boolean): [Employee!]!
    employee(id: ID!): Employee
    payslips(period: String, employeeId: ID): [Payslip!]!
    leaveRequests(status: String): [LeaveRequest!]!
    "Novedades de nómina por periodo (YYYY-MM) o rango de fechas"
    novelties(period: String, employeeId: ID, from: String, to: String): [Novelty!]!
    payrollParams(year: Int): PayrollParams

    dashboard(from: String, to: String): Dashboard!
  }

  input UserInput {
    name: String!
    email: String!
    password: String!
    role: String!
    roleId: ID
    posTerminal: String
    employeeId: String
  }
  input UserUpdate {
    name: String
    role: String
    "Rol personalizado; null quita el rol personalizado y vuelve al rol base"
    roleId: ID
    active: Boolean
    password: String
    posTerminal: String
    employeeId: String
  }
  input PlatformUserInput {
    name: String!
    email: String!
    password: String!
    "owner | admin | viewer"
    platformRole: String!
    companyId: ID
  }
  input PlatformUserUpdate {
    name: String
    platformRole: String
    active: Boolean
    password: String
  }
  input RoleInput {
    id: ID
    name: String!
    description: String
    baseRole: String!
    suites: [String!]!
    permissions: JSON!
  }
  input SignupInput {
    companyName: String!
    nit: String
    city: String
    phone: String
    name: String!
    email: String!
    password: String!
  }
  input CompanyInput {
    name: String
    nit: String
    address: String
    city: String
    phone: String
    email: String
    receiptFooter: String
  }

  input RecordInput {
    table: String!
    row: JSON!
  }

  type Mutation {
    "Crea o actualiza registros (máx. 40, atómico) con las mismas reglas de rol y LWW del sync. Devuelve los ids."
    saveRecords(changes: [RecordInput!]!): [ID!]!
    "Borrado lógico (se propaga a todos los equipos)"
    deleteRecord(table: String!, id: ID!): Boolean!
    login(email: String!, password: String!, deviceId: String): AuthPayload!
    "Auto-registro: crea una empresa nueva con su administrador (si ALLOW_SIGNUP=true)"
    signup(input: SignupInput!): AuthPayload!
    saveRole(input: RoleInput!): CustomRole!
    deleteRole(id: ID!): Boolean!
    logout: Boolean!
    changePassword(current: String!, next: String!): Boolean!
    createUser(input: UserInput!): User!
    updateUser(id: ID!, input: UserUpdate!): User!
    updateCompany(input: CompanyInput!): Company!
    createPlatformUser(input: PlatformUserInput!): User!
    updatePlatformUser(id: ID!, input: PlatformUserUpdate!): User!
    approveExpense(id: ID!, approve: Boolean!, notes: String): Expense!
    approveLeave(id: ID!, approve: Boolean!, notes: String): LeaveRequest!
  }
`;
