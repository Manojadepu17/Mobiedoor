ALTER TABLE `inventory_adjustments`
DROP FOREIGN KEY `inventory_adjustments_product_id_fkey`;

ALTER TABLE `inventory_adjustments`
ADD CONSTRAINT `inventory_adjustments_product_id_fkey`
FOREIGN KEY (`product_id`) REFERENCES `products`(`id`)
ON DELETE RESTRICT ON UPDATE CASCADE;
