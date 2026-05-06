-- CreateEnum
CREATE TYPE "ChatIntent" AS ENUM ('general', 'stock_check', 'order_status', 'promo', 'product_recommendation', 'shipping', 'return_policy', 'payment', 'authenticity', 'complaint', 'human_handoff');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "ChatSessionStatus" AS ENUM ('active', 'idle', 'handoff', 'resolved', 'abandoned');

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "userId" BIGINT,
    "visitorId" TEXT,
    "openclawSessionId" TEXT,
    "pageUrl" TEXT,
    "productSlug" TEXT,
    "status" "ChatSessionStatus" NOT NULL DEFAULT 'active',
    "lastIntent" "ChatIntent",
    "handoffReason" TEXT,
    "handoffAssignedTo" BIGINT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "intent" "ChatIntent",
    "needsData" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerHandoff" BOOLEAN NOT NULL DEFAULT false,
    "tokensUsed" INTEGER,
    "durationMs" INTEGER,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatSession_openclawSessionId_key" ON "ChatSession"("openclawSessionId");

-- CreateIndex
CREATE INDEX "ChatSession_userId_idx" ON "ChatSession"("userId");

-- CreateIndex
CREATE INDEX "ChatSession_visitorId_idx" ON "ChatSession"("visitorId");

-- CreateIndex
CREATE INDEX "ChatSession_status_idx" ON "ChatSession"("status");

-- CreateIndex
CREATE INDEX "ChatSession_lastActivityAt_idx" ON "ChatSession"("lastActivityAt");

-- CreateIndex
CREATE INDEX "ChatSession_createdAt_idx" ON "ChatSession"("createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_idx" ON "ChatMessage"("sessionId");

-- CreateIndex
CREATE INDEX "ChatMessage_role_idx" ON "ChatMessage"("role");

-- CreateIndex
CREATE INDEX "ChatMessage_intent_idx" ON "ChatMessage"("intent");

-- CreateIndex
CREATE INDEX "ChatMessage_createdAt_idx" ON "ChatMessage"("createdAt");

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
