CREATE TABLE `initial_setup_state` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `completed_at` DATETIME(3) NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `initial_setup_state` (`id`) VALUES (1);
