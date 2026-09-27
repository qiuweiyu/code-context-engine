package backend

type Repository interface {
    List() int
}
type FirstRepo struct{}
func (r *FirstRepo) List() int { return 1 }
type SecondRepo struct{}
func (r *SecondRepo) List() int { return 2 }
type Service struct { repo Repository }
func (s *Service) Run() int { return s.repo.List() }
func ReadCount() int { return 3 }
func CallReadCount() int { return ReadCount() }
