-- Folder locks (own password per folder) and short-lived download links.
-- AlterTable
ALTER TABLE `folders` ADD COLUMN `lock_hash` VARCHAR(255) NULL,
    ADD COLUMN `locked_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `download_tokens` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `token_hash` VARCHAR(255) NOT NULL,
    `file_ids` JSON NOT NULL,
    `folder_id` CHAR(36) NULL,
    `name` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `download_tokens_token_hash_key`(`token_hash`),
    INDEX `download_tokens_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `download_tokens` ADD CONSTRAINT `download_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

