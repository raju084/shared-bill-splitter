import { createFileRoute } from '@tanstack/react-router'
import { useReducer, useState } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Share = {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
}

type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}

type Member = { id: string; homeId: string; name: string }

type Balance = { memberId: string; name: string; outstandingCents: number }

type ApiError = { error: string }

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
export const Route = createFileRoute('/')({ component: App })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

async function apiFetch<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
    if (!res.ok) {
      const message =
        data && typeof data === 'object' && 'error' in data
          ? String((data as ApiError).error)
          : `HTTP ${res.status}`
      return { ok: false, status: res.status, message }
    }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, message: 'Network error — is the API running?' }
  }
}

// ---------------------------------------------------------------------------
// App state reducer for pay updates
// ---------------------------------------------------------------------------
type AppState = {
  bills: Bill[]
  members: Member[]
  balances: Balance[]
  payErrors: Record<string, string> // shareId -> error message
  paying: Record<string, boolean> // shareId -> loading
}

type Action =
  | { type: 'SET_BILLS'; bills: Bill[] }
  | { type: 'SET_MEMBERS'; members: Member[] }
  | { type: 'SET_BALANCES'; balances: Balance[] }
  | { type: 'PAY_START'; shareId: string }
  | { type: 'PAY_SUCCESS'; shareId: string; share: Share; balances: Balance[] }
  | { type: 'PAY_ERROR'; shareId: string; message: string }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_BILLS':
      return { ...state, bills: action.bills }
    case 'SET_MEMBERS':
      return { ...state, members: action.members }
    case 'SET_BALANCES':
      return { ...state, balances: action.balances }
    case 'PAY_START':
      return {
        ...state,
        paying: { ...state.paying, [action.shareId]: true },
        payErrors: { ...state.payErrors, [action.shareId]: '' },
      }
    case 'PAY_SUCCESS': {
      const bills = state.bills.map((bill) => ({
        ...bill,
        shares: bill.shares.map((s) => (s.id === action.shareId ? action.share : s)),
      }))
      return {
        ...state,
        bills,
        balances: action.balances,
        paying: { ...state.paying, [action.shareId]: false },
      }
    }
    case 'PAY_ERROR':
      return {
        ...state,
        paying: { ...state.paying, [action.shareId]: false },
        payErrors: { ...state.payErrors, [action.shareId]: action.message },
      }
  }
}

// ---------------------------------------------------------------------------
// Main App component
// ---------------------------------------------------------------------------
function App() {
  const [homeIdInput, setHomeIdInput] = useState('')
  const [activeHomeState, setActiveHome] = useState('')
  const [newHomeName, setNewHomeName] = useState('')
  const [newMemberName, setNewMemberName] = useState('')
  const [newBillTitle, setNewBillTitle] = useState('')
  const [newBillAmount, setNewBillAmount] = useState('')
  const [formError, setFormError] = useState('')
  const [loadingHome, setLoadingHome] = useState(false)

  const [state, dispatch] = useReducer(reducer, {
    bills: [],
    members: [],
    balances: [],
    payErrors: {},
    paying: {},
  })

  // ---- create home ----
  const handleCreateHome = async () => {
    if (!newHomeName.trim()) {
      setFormError('Home name is required')
      return
    }
    setFormError('')
    setLoadingHome(true)
    const res = await apiFetch<{ id: string; name: string }>('POST', '/api/homes', {
      body: { name: newHomeName.trim() },
    })
    setLoadingHome(false)
    if (!res.ok) {
      setFormError(res.message)
      return
    }
    setHomeIdInput(res.data.id)
    dispatch({ type: 'SET_BILLS', bills: [] })
    dispatch({ type: 'SET_MEMBERS', members: [] })
    dispatch({ type: 'SET_BALANCES', balances: [] })
    await handleLoadHome(res.data.id)
    setNewHomeName('')
  }

  // ---- load home ----
  const handleLoadHome = async (id?: string) => {
    const hid = (id ?? homeIdInput).trim()
    if (!hid) {
      setFormError('Enter a home ID')
      return
    }
    setFormError('')
    setLoadingHome(true)
    const balancesRes = await apiFetch<{ balances: Balance[] }>('GET', `/api/homes/${hid}/balances`)
    setLoadingHome(false)
    if (!balancesRes.ok) {
      setFormError(balancesRes.status === 404 ? 'Home not found' : balancesRes.message)
      return
    }
    dispatch({ type: 'SET_BALANCES', balances: balancesRes.data.balances })
    dispatch({ type: 'SET_BILLS', bills: [] })
    setHomeIdInput(hid)
    setActiveHome(hid)
  }

  // ---- add member ----
  const handleAddMember = async () => {
    if (!newMemberName.trim()) {
      setFormError('Member name is required')
      return
    }
    setFormError('')
    const res = await apiFetch<Member>('POST', `/api/homes/${activeHomeState}/members`, {
      body: { name: newMemberName.trim() },
    })
    if (!res.ok) {
      setFormError(res.message)
      return
    }
    dispatch({ type: 'SET_MEMBERS', members: [...state.members, res.data] })
    setNewMemberName('')
    const bal = await apiFetch<{ balances: Balance[] }>(
      'GET',
      `/api/homes/${activeHomeState}/balances`,
    )
    if (bal.ok) dispatch({ type: 'SET_BALANCES', balances: bal.data.balances })
  }

  // ---- create bill ----
  const handleCreateBill = async () => {
    const totalCents = Math.round(Number(newBillAmount) * 100)
    if (!newBillTitle.trim() || !newBillAmount) {
      setFormError('Title and amount are required')
      return
    }
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      setFormError('Amount must be a positive number')
      return
    }
    setFormError('')
    const res = await apiFetch<Bill>('POST', `/api/homes/${activeHomeState}/bills`, {
      body: { title: newBillTitle.trim(), totalCents },
    })
    if (!res.ok) {
      setFormError(res.message)
      return
    }
    dispatch({ type: 'SET_BILLS', bills: [...state.bills, res.data] })
    setNewBillTitle('')
    setNewBillAmount('')
    const bal = await apiFetch<{ balances: Balance[] }>(
      'GET',
      `/api/homes/${activeHomeState}/balances`,
    )
    if (bal.ok) dispatch({ type: 'SET_BALANCES', balances: bal.data.balances })
  }

  // ---- pay share ----
  const handlePay = async (billId: string, shareId: string) => {
    dispatch({ type: 'PAY_START', shareId })
    const key = crypto.randomUUID()
    const res = await apiFetch<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
      headers: { 'Idempotency-Key': key },
    })
    if (!res.ok) {
      dispatch({ type: 'PAY_ERROR', shareId, message: res.message })
      return
    }
    const bal = await apiFetch<{ balances: Balance[] }>(
      'GET',
      `/api/homes/${activeHomeState}/balances`,
    )
    dispatch({
      type: 'PAY_SUCCESS',
      shareId,
      share: res.data,
      balances: bal.ok ? bal.data.balances : state.balances,
    })
  }

  // ---- member name lookup ----
  const memberName = (memberId: string) =>
    state.balances.find((b) => b.memberId === memberId)?.name ??
    state.members.find((m) => m.id === memberId)?.name ??
    memberId.slice(0, 8)

  const isHome = Boolean(activeHomeState)

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>🏠 Bill Splitter</h1>

      {/* ---- Home Panel ---- */}
      <section style={styles.card}>
        <h2 style={styles.h2}>Home</h2>
        {!isHome ? (
          <>
            <div style={styles.row}>
              <input
                style={styles.input}
                placeholder="Create new home name"
                value={newHomeName}
                onChange={(e) => setNewHomeName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateHome()}
              />
              <button
                type="button"
                style={styles.btn}
                onClick={handleCreateHome}
                disabled={loadingHome}
              >
                {loadingHome ? '…' : 'Create Home'}
              </button>
            </div>
            <div style={styles.divider}>— or load existing —</div>
            <div style={styles.row}>
              <input
                style={styles.input}
                placeholder="Paste home ID"
                value={homeIdInput}
                onChange={(e) => setHomeIdInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLoadHome()}
              />
              <button
                type="button"
                style={styles.btn}
                onClick={() => handleLoadHome()}
                disabled={loadingHome}
              >
                {loadingHome ? '…' : 'Load Home'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={styles.meta}>
              ID: <code style={styles.code}>{activeHomeState}</code>
            </p>
            <button
              type="button"
              style={{ ...styles.btn, background: '#64748b' }}
              onClick={() => {
                setActiveHome('')
                dispatch({ type: 'SET_BILLS', bills: [] })
                dispatch({ type: 'SET_MEMBERS', members: [] })
                dispatch({ type: 'SET_BALANCES', balances: [] })
              }}
            >
              Switch Home
            </button>
          </>
        )}
        {formError && <p style={styles.error}>{formError}</p>}
      </section>

      {isHome && (
        <>
          {/* ---- Add Member ---- */}
          <section style={styles.card}>
            <h2 style={styles.h2}>Add Member</h2>
            <div style={styles.row}>
              <input
                style={styles.input}
                placeholder="Member name"
                value={newMemberName}
                onChange={(e) => setNewMemberName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddMember()}
              />
              <button type="button" style={styles.btn} onClick={handleAddMember}>
                Add
              </button>
            </div>
          </section>

          {/* ---- Balances ---- */}
          <section style={styles.card}>
            <h2 style={styles.h2}>Balances</h2>
            {state.balances.length === 0 ? (
              <p style={styles.empty}>No members yet.</p>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Member</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {state.balances.map((b) => (
                    <tr key={b.memberId}>
                      <td style={styles.td}>{b.name}</td>
                      <td
                        style={{
                          ...styles.td,
                          textAlign: 'right',
                          color: b.outstandingCents > 0 ? '#dc2626' : '#16a34a',
                        }}
                      >
                        {fmt(b.outstandingCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ---- Add Bill ---- */}
          <section style={styles.card}>
            <h2 style={styles.h2}>Add Bill</h2>
            <div style={styles.row}>
              <input
                style={styles.input}
                placeholder="Title (e.g. Rent)"
                value={newBillTitle}
                onChange={(e) => setNewBillTitle(e.target.value)}
              />
              <input
                style={{ ...styles.input, maxWidth: 120 }}
                placeholder="Amount $"
                type="number"
                min="0.01"
                step="0.01"
                value={newBillAmount}
                onChange={(e) => setNewBillAmount(e.target.value)}
              />
              <button type="button" style={styles.btn} onClick={handleCreateBill}>
                Add Bill
              </button>
            </div>
          </section>

          {/* ---- Bills ---- */}
          <section style={styles.card}>
            <h2 style={styles.h2}>Bills</h2>
            {state.bills.length === 0 ? (
              <p style={styles.empty}>No bills yet — add one above.</p>
            ) : (
              state.bills.map((bill) => (
                <div key={bill.id} style={styles.billCard}>
                  <div style={styles.billHeader}>
                    <strong>{bill.title}</strong>
                    <span style={styles.meta}>{fmt(bill.totalCents)}</span>
                  </div>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Member</th>
                        <th style={{ ...styles.th, textAlign: 'right' }}>Share</th>
                        <th style={{ ...styles.th, textAlign: 'center' }}>Status</th>
                        <th style={styles.th} />
                      </tr>
                    </thead>
                    <tbody>
                      {bill.shares.map((share) => {
                        const isPaying = state.paying[share.id]
                        const payErr = state.payErrors[share.id]
                        return (
                          <tr key={share.id}>
                            <td style={styles.td}>{memberName(share.memberId)}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>
                              {fmt(share.amountCents)}
                            </td>
                            <td style={{ ...styles.td, textAlign: 'center' }}>
                              {share.paidAt ? (
                                <span style={{ color: '#16a34a' }}>✓ Paid</span>
                              ) : (
                                <span style={{ color: '#dc2626' }}>Unpaid</span>
                              )}
                            </td>
                            <td style={styles.td}>
                              {!share.paidAt && (
                                <button
                                  type="button"
                                  style={{ ...styles.btnSmall, opacity: isPaying ? 0.6 : 1 }}
                                  disabled={isPaying}
                                  onClick={() => handlePay(bill.id, share.id)}
                                >
                                  {isPaying ? '…' : 'Pay'}
                                </button>
                              )}
                              {payErr && <span style={styles.error}> {payErr}</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </main>
  )
}

// ---------------------------------------------------------------------------
// Styles (plain objects)
// ---------------------------------------------------------------------------
const styles = {
  main: {
    maxWidth: 720,
    margin: '0 auto',
    padding: '24px 16px',
    fontFamily: 'system-ui, sans-serif',
    color: '#1e293b',
  } as React.CSSProperties,
  h1: { fontSize: 28, margin: '0 0 24px' } as React.CSSProperties,
  h2: { fontSize: 18, margin: '0 0 12px' } as React.CSSProperties,
  card: {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: 16,
    marginBottom: 20,
  } as React.CSSProperties,
  billCard: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 6,
    padding: 12,
    marginBottom: 12,
  } as React.CSSProperties,
  billHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 8,
  } as React.CSSProperties,
  row: { display: 'flex', gap: 8, flexWrap: 'wrap' } as React.CSSProperties,
  input: {
    flex: 1,
    minWidth: 160,
    padding: '8px 10px',
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    fontSize: 14,
  } as React.CSSProperties,
  btn: {
    padding: '8px 16px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  btnSmall: {
    padding: '4px 10px',
    background: '#10b981',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 13,
  } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 14 },
  th: {
    textAlign: 'left' as const,
    padding: '6px 8px',
    borderBottom: '1px solid #e2e8f0',
    color: '#64748b',
    fontWeight: 600,
  },
  td: { padding: '6px 8px', borderBottom: '1px solid #f1f5f9' } as React.CSSProperties,
  error: { color: '#dc2626', fontSize: 13, marginTop: 6 } as React.CSSProperties,
  empty: { color: '#94a3b8', fontStyle: 'italic' } as React.CSSProperties,
  meta: { color: '#64748b', fontSize: 13 } as React.CSSProperties,
  code: {
    background: '#e2e8f0',
    padding: '1px 4px',
    borderRadius: 3,
    fontSize: 12,
  } as React.CSSProperties,
  divider: { textAlign: 'center' as const, color: '#94a3b8', margin: '10px 0', fontSize: 13 },
}
