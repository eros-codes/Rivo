-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "auth_tag" TEXT,
ADD COLUMN     "ciphertext" TEXT,
ADD COLUMN     "iv" TEXT,
ADD COLUMN     "key_id" TEXT,
ADD COLUMN     "wrapped_dek" TEXT,
ALTER COLUMN "text" DROP NOT NULL;
