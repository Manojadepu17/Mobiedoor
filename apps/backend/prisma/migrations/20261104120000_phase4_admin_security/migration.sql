-- AlterTable
ALTER TABLE `contact_enquiries` ADD COLUMN `admin_notes` TEXT NULL,
    ADD COLUMN `status` ENUM('NEW', 'IN_PROGRESS', 'RESOLVED', 'ARCHIVED') NOT NULL DEFAULT 'NEW';

-- AlterTable
ALTER TABLE `partnership_enquiries` ADD COLUMN `admin_notes` TEXT NULL,
    ADD COLUMN `status` ENUM('NEW', 'IN_PROGRESS', 'RESOLVED', 'ARCHIVED') NOT NULL DEFAULT 'NEW';

-- AlterTable
ALTER TABLE `products` ADD COLUMN `availability` ENUM('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'DISCONTINUED') NOT NULL DEFAULT 'OUT_OF_STOCK',
    ADD COLUMN `sku` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `trade_in_enquiries` ADD COLUMN `admin_notes` TEXT NULL,
    ADD COLUMN `status` ENUM('NEW', 'IN_PROGRESS', 'RESOLVED', 'ARCHIVED') NOT NULL DEFAULT 'NEW';

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(191) NOT NULL,
    `token_hash` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sessions_token_hash_key`(`token_hash`),
    INDEX `sessions_user_id_idx`(`user_id`),
    INDEX `sessions_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_adjustments` (
    `id` VARCHAR(191) NOT NULL,
    `product_id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `inventory_adjustments_product_id_created_at_idx`(`product_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `activity_logs` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `action` VARCHAR(100) NOT NULL,
    `entity` VARCHAR(100) NOT NULL,
    `entity_id` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `activity_logs_created_at_idx`(`created_at`),
    INDEX `activity_logs_entity_entity_id_idx`(`entity`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `products_sku_key` ON `products`(`sku`);

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_adjustments` ADD CONSTRAINT `inventory_adjustments_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_adjustments` ADD CONSTRAINT `inventory_adjustments_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activity_logs` ADD CONSTRAINT `activity_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
