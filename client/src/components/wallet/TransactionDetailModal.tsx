/**
 * TransactionDetailModal — Shows full transaction details for a wallet tx.
 *
 * Replaces opening the explorer directly: users see a clean detail view
 * with all relevant info, copy-able txid, and explorer links at the bottom.
 *
 * Supports Bitcoin (multi-address, sats fee, mempool/blockstream links)
 * and EVM chains (gas fee, from/to, etherscan-family links).
 */

import { useState } from 'react'
import {
  X,
  Copy,
  Check,
  ExternalLink,
  ArrowUpRight,
  ArrowDownLeft,
  Clock,
  Fuel,
  Hash,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import type { TxItem } from '@/stores/walletStore'
import type { Chain } from '@/lib/crypto/derive'

// ── Explorer URLs ──

const EXPLORER_URLS: Record<string, string> = {
  ethereum: 'https://etherscan.io',
  bnb: 'https://bscscan.com',
  polygon: 'https://polygonscan.com',
  avalanche: 'https://snowtrace.io',
  base: 'https://basescan.org',
}

// ── Gas fee formatter ──

function formatGasFee(gasUsed: string, gasPrice: string): string {
  const fee = BigInt(gasUsed) * BigInt(gasPrice)
  const whole = fee / BigInt(10 ** 18)
  const frac = fee % BigInt(10 ** 18)
  if (frac === 0n) return whole.toString()
  const fracStr = frac
    .toString()
    .padStart(18, '0')
    .slice(0, 6)
    .replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : whole.toString()
}

// ── Address display ──

function AddressLine({
  address,
  isOwn,
  onCopy,
}: {
  address: string
  isOwn: boolean
  onCopy: (text: string) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => onCopy(address)}
          className={cn(
            'block w-full text-left font-mono text-xs break-all rounded px-1.5 py-0.5 transition-colors cursor-pointer hover:bg-secondary/40',
            isOwn ? 'text-primary font-semibold' : 'text-foreground',
          )}
        >
          {address}
          {isOwn && (
            <span className="ml-1.5 text-[10px] text-primary/70 font-normal">(you)</span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>Click to copy</TooltipContent>
    </Tooltip>
  )
}

// ── Detail row ──

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon size={12} className="text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
          {label}
        </span>
      </div>
      <div className="pl-[18px]">{children}</div>
    </div>
  )
}

// ── Props ──

interface TransactionDetailModalProps {
  tx: TxItem | null // null = closed
  chain: Chain
  chainSymbol: string // e.g. 'ETH', 'BTC'
  displaySymbol: string // could be token symbol like 'USDT'
  userAddress?: string // to highlight own addresses
  onClose: () => void
}

export function TransactionDetailModal({
  tx,
  chain,
  chainSymbol,
  displaySymbol,
  userAddress,
  onClose,
}: TransactionDetailModalProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null)

  if (!tx) return null

  const isBitcoin = chain === 'bitcoin'
  const isReceived = tx.type === 'in'

  // ── Copy handler ──

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  // ── Address matching ──

  const isOwnAddress = (addr: string) => {
    if (!userAddress) return false
    return addr.toLowerCase() === userAddress.toLowerCase()
  }

  // ── Date formatting ──

  const formattedDate = new Date(tx.timestamp * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  // ── Truncate txid ──

  const truncatedTxid =
    tx.txid.length > 20
      ? `${tx.txid.slice(0, 10)}…${tx.txid.slice(-10)}`
      : tx.txid

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="relative w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 backdrop-blur-sm rounded-t-2xl px-5 py-4">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                  isReceived
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'bg-rose-500/15 text-rose-400',
                )}
              >
                {isReceived ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {isReceived ? 'Received' : 'Sent'}
                </h2>
                <p
                  className={cn(
                    'text-sm font-medium',
                    isReceived ? 'text-emerald-400' : 'text-rose-400',
                  )}
                >
                  {isReceived ? '+' : '−'}
                  {tx.amount} {displaySymbol}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>
          </div>

          {/* ── Body ── */}
          <div className="p-5 space-y-4">
            {/* Date & Time */}
            <DetailRow icon={Clock} label="Date & Time">
              <p className="text-sm text-foreground">{formattedDate}</p>
            </DetailRow>

            {/* Status */}
            <DetailRow icon={Hash} label="Status">
              {isBitcoin ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 text-sm font-medium',
                    tx.confirmed ? 'text-emerald-400' : 'text-amber-400',
                  )}
                >
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full',
                      tx.confirmed ? 'bg-emerald-400' : 'bg-amber-400',
                    )}
                  />
                  {tx.confirmed ? 'Confirmed' : 'Pending'}
                </span>
              ) : (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 text-sm font-medium',
                    tx.isError ? 'text-rose-400' : 'text-emerald-400',
                  )}
                >
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full',
                      tx.isError ? 'bg-rose-400' : 'bg-emerald-400',
                    )}
                  />
                  {tx.isError ? 'Failed' : 'Confirmed'}
                </span>
              )}
            </DetailRow>

            {/* Fee */}
            {isBitcoin && tx.fee != null && (
              <DetailRow icon={Fuel} label="Fee">
                <p className="text-sm text-foreground">
                  {tx.fee.toLocaleString()} sats
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({(tx.fee / 1e8).toFixed(8)} BTC)
                  </span>
                </p>
              </DetailRow>
            )}

            {!isBitcoin && tx.gasUsed && tx.gasPrice && (
              <DetailRow icon={Fuel} label="Gas Fee">
                <p className="text-sm text-foreground">
                  {formatGasFee(tx.gasUsed, tx.gasPrice)} {chainSymbol}
                </p>
              </DetailRow>
            )}

            {/* Addresses — Bitcoin (multi) */}
            {isBitcoin && tx.fromAddresses && tx.fromAddresses.length > 0 && (
              <DetailRow icon={Users} label="From">
                <div className="space-y-0.5">
                  {tx.fromAddresses.map((addr) => (
                    <AddressLine
                      key={addr}
                      address={addr}
                      isOwn={isOwnAddress(addr)}
                      onCopy={(t) => handleCopy(t, `from-${addr}`)}
                    />
                  ))}
                </div>
              </DetailRow>
            )}

            {isBitcoin && tx.toAddresses && tx.toAddresses.length > 0 && (
              <DetailRow icon={Users} label="To">
                <div className="space-y-0.5">
                  {tx.toAddresses.map((addr) => (
                    <AddressLine
                      key={addr}
                      address={addr}
                      isOwn={isOwnAddress(addr)}
                      onCopy={(t) => handleCopy(t, `to-${addr}`)}
                    />
                  ))}
                </div>
              </DetailRow>
            )}

            {/* Addresses — EVM (single from/to) */}
            {!isBitcoin && tx.from && (
              <DetailRow icon={Users} label="From">
                <AddressLine
                  address={tx.from}
                  isOwn={isOwnAddress(tx.from)}
                  onCopy={(t) => handleCopy(t, 'from')}
                />
              </DetailRow>
            )}

            {!isBitcoin && tx.to && (
              <DetailRow icon={Users} label="To">
                <AddressLine
                  address={tx.to}
                  isOwn={isOwnAddress(tx.to)}
                  onCopy={(t) => handleCopy(t, 'to')}
                />
              </DetailRow>
            )}

            {/* Transaction ID / Hash */}
            <DetailRow icon={Hash} label={isBitcoin ? 'Transaction ID' : 'Transaction Hash'}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-foreground break-all">
                  {truncatedTxid}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleCopy(tx.txid, 'txid')}
                      className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors cursor-pointer"
                    >
                      {copiedField === 'txid' ? (
                        <Check size={14} className="text-emerald-400" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{copiedField === 'txid' ? 'Copied!' : 'Copy full hash'}</TooltipContent>
                </Tooltip>
              </div>
            </DetailRow>

            {/* ── Explorer Links ── */}
            <div className="pt-2 space-y-2">
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                View in Explorer
              </p>

              {isBitcoin ? (
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { name: 'Mempool', url: `https://mempool.space/tx/${tx.txid}` },
                    { name: 'Blockstream', url: `https://blockstream.info/tx/${tx.txid}` },
                    { name: 'Blockchain', url: `https://www.blockchain.com/btc/tx/${tx.txid}` },
                  ].map((exp) => (
                    <a
                      key={exp.name}
                      href={exp.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl border border-border bg-secondary/20 text-foreground hover:bg-secondary/40 transition-colors"
                    >
                      <ExternalLink size={14} />
                      <span className="text-[11px] font-medium">{exp.name}</span>
                    </a>
                  ))}
                </div>
              ) : (
                (() => {
                  const explorerUrl = EXPLORER_URLS[chain]
                  const explorerNames: Record<string, string> = {
                    ethereum: 'Etherscan',
                    bnb: 'BscScan',
                    polygon: 'PolygonScan',
                    avalanche: 'Snowtrace',
                    base: 'BaseScan',
                  }
                  const name = explorerNames[chain] || 'Explorer'
                  return explorerUrl ? (
                    <a
                      href={`${explorerUrl}/tx/${tx.txid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-border bg-secondary/20 text-sm font-medium text-foreground hover:bg-secondary/40 transition-colors"
                    >
                      <ExternalLink size={14} />
                      {name}
                    </a>
                  ) : null
                })()
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
