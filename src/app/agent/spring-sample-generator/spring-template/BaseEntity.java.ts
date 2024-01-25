export const source = `
package {{packageName}}.domain.entity;

import jakarta.persistence.Column;
import jakarta.persistence.MappedSuperclass;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import java.time.LocalDateTime;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Data
@NoArgsConstructor
@AllArgsConstructor
@MappedSuperclass
@Slf4j
public class BaseEntity {

  @Column
  private LocalDateTime tsIns;
  @Column
  private LocalDateTime tsUpd;

  @PrePersist
  public void onPrePersist() {
    this.tsIns = LocalDateTime.now();
    this.tsUpd = LocalDateTime.now();
//    log.info("INS:" + this.tsIns);
  }

  @PreUpdate
  public void onPreUpdate() {
    this.tsUpd = LocalDateTime.now();
//    log.info("UPD:" + this.tsUpd);
  }
}
`;
export default source.trim();